import {
  commands,
  FileType,
  QuickInputButton,
  QuickPick,
  ThemeIcon,
  Uri,
  ViewColumn,
  window,
  workspace,
} from "vscode";
import { action, Action } from "./action";
import { FileItem, fileRecordCompare } from "./fileitem";
import { endsWithPathSeparator, Path } from "./path";
import { None, Option, Result, Some } from "./rust";
import * as OSPath from "path";
import * as vscode from "vscode";
import { homedir } from "os";
import { Rules } from "./filter";
import pLanguages from "./languages";
import { setActive } from "./extension";

interface AutoCompletion {
  index: number;
  items: FileItem[];
}

export enum ConfigItem {
  removeIgnoredFiles = "removeIgnoredFiles",
  hideDotfiles = "hideDotfiles",
  hideIgnoreFiles = "hideIgnoredFiles",
  ignoreFileTypes = "ignoreFileTypes",
  labelIgnoredFiles = "labelIgnoredFiles",
}

export function config<T>(item: ConfigItem): T | undefined {
  return workspace.getConfiguration("advanced-file").get(item);
}

export function setContext(state: boolean) {
  vscode.commands.executeCommand("setContext", "inAdvancedFile", state);
}

class AdvancedFile extends vscode.Disposable {
  current: QuickPick<FileItem>;
  path: Path;
  file: Option<string>;
  items: FileItem[] = [];
  pathHistory: { [path: string]: Option<string> };
  inActions: boolean = false;
  keepAlive: boolean = false;
  autoCompletion?: AutoCompletion;
  actionsButton: QuickInputButton;
  stepOutButton: QuickInputButton;
  stepInButton: QuickInputButton;

  constructor(path: Path, file: Option<string>) {
    super(() => this.dispose());
    this.stepInButton = this.createAction("arrow-right", "Step into folder");
    this.stepOutButton = this.createAction("arrow-left", "Step out of folder");
    this.actionsButton = this.createAction(
      "ellipsis",
      "Actions on selected folder/file"
    );
    this.path = path;
    this.file = file;
    this.pathHistory = { [this.path.id]: this.file };
    this.current = window.createQuickPick();
    this.current.buttons = [
      this.actionsButton,
      this.stepOutButton,
      this.stepInButton,
    ];
    this.current.placeholder = "Preparing the file list...";
    this.current.onDidHide(() => {
      if (!this.keepAlive) {
        this.dispose();
      }
    });
    this.current.onDidAccept(this.onDidAccept.bind(this));
    this.current.onDidChangeValue(this.onDidChangeValue.bind(this));
    this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));
    this.update().then(() => {
      this.current.placeholder =
        "Select a file or folder to open or create a new one";
      this.current.busy = false;
    });
  }

  createAction(icon: string, tooltip: string): QuickInputButton {
    return {
      iconPath: new ThemeIcon(icon),
      tooltip,
    };
  }

  dispose() {
    setContext(false);
    this.current.dispose();
    setActive(None);
  }

  hide() {
    this.current.hide();
    setContext(false);
  }

  show() {
    setContext(true);
    this.current.show();
  }

  async update() {
    this.current.enabled = false;
    this.current.show();
    this.current.busy = true;
    this.current.title = this.path.fsPath;
    this.current.value = "";

    const stat: any = (
      await Result.try(workspace.fs.stat(this.path.uri))
    ).unwrap();

    if (
      stat &&
      this.inActions &&
      (stat.type & FileType.File) === FileType.File
    ) {
      this.items = [
        action("$(file) Open this file", Action.OpenFile),
        action(
          "$(split-horizontal) Open this file to the side",
          Action.OpenFileBeside
        ),
        action("$(edit) Rename this file", Action.RenameFile),
        action("$(trash) Delete this file", Action.DeleteFile),
      ];
      this.current.items = this.items;
    } else if (
      stat &&
      this.inActions &&
      (stat.type & FileType.Directory) === FileType.Directory
    ) {
      this.items = [
        action("$(folder-opened) Open this folder", Action.OpenFolder),
        action(
          "$(folder-opened) Open this folder in a new window",
          Action.OpenFolderInNewWindow
        ),
        action("$(edit) Rename this folder", Action.RenameFile),
        action("$(trash) Delete this folder", Action.DeleteFile),
      ];
      this.current.items = this.items;
    } else if (
      stat &&
      (stat.type & FileType.Directory) === FileType.Directory
    ) {
      const records = await workspace.fs.readDirectory(this.path.uri);
      records.sort(fileRecordCompare);
      let items = records.map(
        (entry: [string, FileType]) => new FileItem(entry)
      );
      if (config(ConfigItem.hideIgnoreFiles)) {
        const rules = await Rules.forPath(this.path);
        items = rules.filter(this.path, items);
      }
      if (config(ConfigItem.removeIgnoredFiles)) {
        items = items.filter((item: { alwaysShow: any }) => item.alwaysShow);
      }
      this.items = items;
      this.current.items = items;
      this.current.activeItems = items.filter((item: { name: string }) =>
        this.file.contains(item.name)
      );
    }
    this.current.enabled = true;
  }

  onDidChangeValue(value: string, isAutoComplete = false) {
    if (this.inActions) {
      return;
    }

    if (!isAutoComplete) {
      this.autoCompletion = undefined;
    }

    const existingItem = this.items.find((item) => item.name === value);
    if (value === "") {
      this.current.items = this.items;
      this.current.activeItems = [];
    } else if (existingItem !== undefined) {
      this.current.items = this.items;
      this.current.activeItems = [existingItem];
    } else if (value.startsWith(":")) {
      commands.executeCommand(
        "workbench.action.gotoLine",
        this.path.uri,
        value.replace(":", "")
      );
    } else if (value.startsWith("@")) {
      commands.executeCommand(
        "workbench.action.showAllSymbols",
        value.replace("@", "")
      );
    } else {
      endsWithPathSeparator(value).match(
        () => {},
        () => {
          if (value === "~") {
            this.stepIntoFolder(Path.fromFilePath(homedir()));
          } else if (value === "..") {
            this.stepOut();
          } else {
            this.stepIntoFolder(this.path.append(value));
          }

          const newFile = this.newItem(
            "$(file-add)",
            "Create a new file",
            value,
            Action.NewFile
          );
          const newFolder = this.newItem(
            "$(file-directory-create)",
            "Create a new folder",
            value,
            Action.NewFolder
          );
          this.current.items = [...this.items, newFile, newFolder];
          if (value.includes(".") && value !== ".") {
            this.current.activeItems = [newFile];
            this.current.items = [...this.items, newFile];
          } else {
            this.current.activeItems = [newFolder];
          }
        }
      );
    }
  }

  newItem(item: string, description: string, value: string, action: Action) {
    return {
      label: `${item} ${value}`,
      name: value,
      description,
      alwaysShow: true,
      action,
    };
  }

  onDidTriggerButton(button: QuickInputButton) {
    if (button === this.stepInButton) {
      this.stepIn();
    } else if (button === this.stepOutButton) {
      this.stepOut();
    } else if (button === this.actionsButton) {
      this.actions();
    }
  }

  activeItem(): Option<FileItem> {
    return new Option(this.current.activeItems[0]);
  }

  async stepIntoFolder(folder: Path) {
    if (!this.path.equals(folder)) {
      this.path = folder;
      this.file = this.pathHistory[this.path.id] || None;
      await this.update();
    }
  }

  async stepIn() {
    this.activeItem().ifSome(async (item) => {
      if (item.action !== undefined) {
        this.runAction(item);
      } else if (item.fileType !== undefined) {
        if ((item.fileType & FileType.Directory) === FileType.Directory) {
          await this.stepIntoFolder(this.path.append(item.name));
        } else if ((item.fileType & FileType.File) === FileType.File) {
          this.path.push(item.name);
          this.file = None;
          this.inActions = true;
          await this.update();
        }
      }
    });
  }

  async stepOut() {
    this.inActions = false;
    if (!this.path.atTop()) {
      this.pathHistory[this.path.id] = this.activeItem().map(
        (item) => item.name
      );
      this.file = this.path.pop();
      await this.update();
    }
  }

  async actions() {
    if (this.inActions) {
      return;
    }
    await this.activeItem().match(
      async (item) => {
        this.inActions = true;
        this.path.push(item.name);
        this.file = None;
        await this.update();
      },
      async () => {
        this.inActions = true;
        this.file = None;
        await this.update();
      }
    );
  }

  async runAction(item: FileItem) {
    switch (item.action) {
      case Action.NewFolder: {
        const folder = Uri.parse(
          OSPath.join(this.path.uri.toString(), item.name)
        );
        workspace.fs.createDirectory(folder);

        await this.update();
        break;
      }
      case Action.NewFile: {
        const uri = this.path.append(item.name).uri;
        // input which language should the file be in (if not entered)
        if (!item.name.includes(".")) {
          const language = await window.showQuickPick(pLanguages);
          if (!language) {
            break;
          }
          const extension = language?.slice(
            language.indexOf("(") + 1,
            language.indexOf(")")
          );
          const fileUri = this.path.append(`${item.name}.${extension}`).uri;
          this.openFile(fileUri.with({ scheme: "untitled" }));
          break;
        }
        this.openFile(uri.with({ scheme: "untitled" }));
        break;
      }
      case Action.OpenFile: {
        const path = this.path.clone();
        if (item.name && item.name.length > 0) {
          path.push(item.name);
        }
        this.openFile(path.uri);
        break;
      }
      case Action.OpenFileBeside: {
        const path = this.path.clone();
        if (item.name && item.name.length > 0) {
          path.push(item.name);
        }
        this.openFile(path.uri, ViewColumn.Beside);
        break;
      }
      case Action.RenameFile: {
        this.keepAlive = true;
        this.hide();
        const uri = this.path.uri;
        // @ts-ignore
        const stat = await workspace.fs.stat(uri);
        const isDir = (stat.type & FileType.Directory) === FileType.Directory;
        const fileName = this.path.pop().unwrapOrElse(() => {
          throw new Error("Can't rename an empty file name!");
        });
        const fileType = isDir ? "folder" : "file";
        const workspaceFolder = this.path
          .getWorkspaceFolder()
          .map((wsf) => wsf.uri);
        const relPath = workspaceFolder
          .andThen((workspaceFolder) =>
            new Path(uri).relativeTo(workspaceFolder)
          )
          .unwrapOr(fileName);
        const extension = OSPath.extname(relPath);
        const startSelection = relPath.length - fileName.length;
        const endSelection =
          startSelection + (fileName.length - extension.length);
        const result = await window.showInputBox({
          prompt: `Enter the new ${fileType} name`,
          value: relPath,
          valueSelection: [startSelection, endSelection],
        });
        this.file = Some(fileName);
        if (result !== undefined) {
          const newUri = workspaceFolder.match(
            (workspaceFolder) => Uri.joinPath(workspaceFolder, result),
            () => Uri.joinPath(this.path.uri, result)
          );
          if ((await Result.try(workspace.fs.rename(uri, newUri))).isOk()) {
            this.file = Some(OSPath.basename(result));
          } else {
            window.showErrorMessage(
              `Failed to rename ${fileType} "${fileName}"`
            );
          }
        }
        this.show();
        this.keepAlive = false;
        this.inActions = false;
        this.update();
        break;
      }
      case Action.DeleteFile: {
        this.keepAlive = true;
        this.hide();
        const uri = this.path.uri;
        const stat = await workspace.fs.stat(uri);
        const isDir = (stat.type & FileType.Directory) === FileType.Directory;
        const fileName = this.path.pop().unwrapOrElse(() => {
          throw new Error("Can't delete an empty file name!");
        });
        const fileType = isDir ? "folder" : "file";
        const goAhead = `$(trash) Delete the ${fileType} "${fileName}"`;
        const result = await window.showQuickPick(
          ["$(close) Cancel", goAhead],
          {}
        );
        if (result === goAhead) {
          const delOp = await Result.try(
            workspace.fs.delete(uri, { recursive: isDir })
          );
          if (delOp.isErr()) {
            window.showErrorMessage(
              `Failed to delete ${fileType} "${fileName}"`
            );
          }
        }
        this.show();
        this.keepAlive = false;
        this.inActions = false;
        this.update();
        break;
      }
      case Action.OpenFolder: {
        commands.executeCommand("vscode.openFolder", this.path.uri);
        break;
      }
      case Action.OpenFolderInNewWindow: {
        commands.executeCommand("vscode.openFolder", this.path.uri, true);
        break;
      }
      default:
        throw new Error(`Unhandled action ${item.action}`);
    }
  }

  tabCompletion(tabNext: boolean) {
    if (this.inActions) {
      return;
    }

    if (this.autoCompletion) {
      const length = this.autoCompletion.items.length;
      const step = tabNext ? 1 : -1;
      this.autoCompletion.index =
        (this.autoCompletion.index + length + step) % length;
    } else {
      const items = this.items.filter((i) =>
        i.name.toLowerCase().startsWith(this.current.value.toLowerCase())
      );
      this.autoCompletion = {
        index: tabNext ? 0 : items.length - 1,
        items,
      };
    }

    const newIndex = this.autoCompletion.index;
    const length = this.autoCompletion.items.length;
    if (newIndex < length) {
      // This also checks out when items is empty
      const item = this.autoCompletion.items[newIndex];
      this.current.value = item.name;
      if (length === 1 && item.fileType === FileType.Directory) {
        this.current.value += "/";
      }

      this.onDidChangeValue(this.current.value, true);
    }
  }

  onDidAccept() {
    this.autoCompletion = undefined;
    this.activeItem().ifSome((item) => {
      if (item.action !== undefined) {
        this.runAction(item);
      } else if (
        item.fileType !== undefined &&
        (item.fileType & FileType.Directory) === FileType.Directory
      ) {
        this.stepIn();
      } else {
        this.openFile(this.path.append(item.name).uri);
      }
    });
  }

  openFile(uri: Uri, column: ViewColumn = ViewColumn.Active) {
    this.dispose();
    workspace
      .openTextDocument(uri)
      .then((doc: any) => window.showTextDocument(doc, column));
  }
}

export default AdvancedFile;
