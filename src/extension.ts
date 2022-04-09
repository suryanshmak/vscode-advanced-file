import * as vscode from "vscode";
import { Uri, FileType, QuickInputButton, ThemeIcon, ViewColumn } from "vscode";
import * as OS from "os";

import { Result, None, Option, Some } from "./rust";
import { Path, endsWithPathSeparator } from "./path";
import { Rules } from "./filter";
import { FileItem, fileRecordCompare } from "./fileitem";
import { action, Action } from "./action";

export enum ConfigItem {
  RemoveIgnoredFiles = "removeIgnoredFiles",
  HideDotfiles = "hideDotfiles",
  HideIgnoreFiles = "hideIgnoredFiles",
  IgnoreFileTypes = "ignoreFileTypes",
  LabelIgnoredFiles = "labelIgnoredFiles",
}

export function config<A>(item: ConfigItem): A | undefined {
  return vscode.workspace.getConfiguration("file-browser").get(item);
}

let active: Option<FileBrowser> = None;

function setContext(state: boolean) {
  vscode.commands.executeCommand("setContext", "inFileBrowser", state);
}

interface AutoCompletion {
  index: number;
  items: FileItem[];
}

export class FileBrowser {
  current: vscode.QuickPick<FileItem>;
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
    this.stepInButton = this.createAction("arrow-right", "Step into folder");
    this.stepOutButton = this.createAction("arrow-left", "Step out of folder");
    this.actionsButton = this.createAction(
      "ellipsis",
      "Actions on selected folder/file"
    );
    this.path = path;
    this.file = file;
    this.pathHistory = { [this.path.id]: this.file };
    this.current = vscode.window.createQuickPick();
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
    active = None;
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

    const stat = (
      await Result.try(vscode.workspace.fs.stat(this.path.uri))
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
      const records = await vscode.workspace.fs.readDirectory(this.path.uri);
      records.sort(fileRecordCompare);
      let items = records.map(
        (entry: [string, FileType]) => new FileItem(entry)
      );
      if (config(ConfigItem.HideIgnoreFiles)) {
        const rules = await Rules.forPath(this.path);
        items = rules.filter(this.path, items);
      }
      if (config(ConfigItem.RemoveIgnoredFiles)) {
        items = items.filter((item: { alwaysShow: any }) => item.alwaysShow);
      }
      this.items = items;
      this.current.items = items;
      this.current.activeItems = items.filter((item: { name: string }) =>
        this.file.contains(item.name)
      );
    } else {
      this.items = [
        action("$(new-folder) Create this folder", Action.NewFolder),
      ];
      this.current.items = this.items;
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
      this.newItem(
        "$(gotoLine)",
        "Jump to a specific line",
        value.replace(/^:/, ""),
        Action.JumpToLine
      );
    } else {
      endsWithPathSeparator(value).match(
        (path) => {
          if (path === "~") {
            this.stepIntoFolder(Path.fromFilePath(OS.homedir()));
          } else if (path === "..") {
            this.stepOut();
          } else {
            this.stepIntoFolder(this.path.append(path));
          }
        },
        () => {
          const str = "Open as new";
          this.newItem("$(new-file)", `${str} file`, value, Action.NewFile);
          this.newItem(
            "$(new-folder)",
            `${str} folder`,
            value,
            Action.NewFolder
          );
        }
      );
    }
  }

  newItem(item: string, description: string, value: string, action: Action) {
    const newItem = {
      label: `${item} ${value}`,
      name: value,
      description,
      alwaysShow: true,
      action,
    };
    this.current.items = [...this.items, newItem];
    this.current.activeItems = [...this.current.activeItems, newItem];
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
    vscode.workspace
      .openTextDocument(uri)
      .then((doc: any) => vscode.window.showTextDocument(doc, column));
  }
}

export function activate(context: vscode.ExtensionContext) {
  setContext(false);

  context.subscriptions.push(
    vscode.commands.registerCommand("file-browser.open", () => {
      const document = vscode.window.activeTextEditor?.document;
      let workspaceFolder =
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders[0];
      let path = new Path(workspaceFolder?.uri || Uri.file(OS.homedir()));
      let file: Option<string> = None;
      if (document && !document.isUntitled) {
        path = new Path(document.uri);
        file = path.pop();
      }
      active = Some(new FileBrowser(path, file));
      setContext(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("file-browser.stepIn", () =>
      active.ifSome((active) => active.stepIn())
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("file-browser.stepOut", () =>
      active.ifSome((active) => active.stepOut())
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("file-browser.actions", () =>
      active.ifSome((active) => active.actions())
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("file-browser.tabNext", () =>
      active.ifSome((active) => active.tabCompletion(true))
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("file-browser.tabPrev", () =>
      active.ifSome((active) => active.tabCompletion(false))
    )
  );
}
