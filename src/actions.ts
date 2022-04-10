import { Action } from "./action";
import * as OSPath from "path";
import { FileItem } from "./fileitem";
import { workspace, window, ViewColumn, FileType, commands, Uri } from "vscode";
import { FileBrowser } from "./extension";
import { Result, Option, Some } from "./rust";
import { Path } from "./path";

export class Actions extends FileBrowser {
  constructor(path: Path, file: Option<string>) {
    super(path, file);
  }

  async runAction(item: FileItem) {
    switch (item.action) {
      case Action.NewFolder: {
        // @ts-ignore
        await workspace.fs.createDirectory(this.path.uri);
        await this.update();
        break;
      }
      case Action.NewFile: {
        const uri = this.path.append(item.name).uri;
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
            // @ts-ignore
            (workspaceFolder) => Uri.joinPath(workspaceFolder, result),
            // @ts-ignore
            () => Uri.joinPath(this.path.uri, result)
          );
          // @ts-ignore
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
        // @ts-ignore
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
      case Action.JumpToLine: {
        commands.executeCommand(
          "workbench.action.gotoLine",
          this.path.uri,
          item.name
        );
      }
      default:
        throw new Error(`Unhandled action ${item.action}`);
    }
  }
}
