import { Uri, workspace, window, ExtensionContext } from "vscode";
import * as vscode from "vscode";
import { homedir } from "os";
import { None, Option, Some } from "./rust";
import { Path } from "./path";
import AdvancedFile, { setContext } from "./advancedFile";

let active: Option<AdvancedFile> = None;

export const setActive = (af: Option<AdvancedFile>) => {
  active = af;
};

export const activate = (context: ExtensionContext) => {
  setContext(true);

  context.subscriptions.push(
    vscode.commands.registerCommand("advanced-file.create", () => {
      const document = window.activeTextEditor?.document;
      const workspaceFolder =
        workspace.workspaceFolders && workspace.workspaceFolders[0];
      let path = new Path(workspaceFolder?.uri || Uri.file(homedir()));
      let file: Option<string> = None;
      if (document && !document.isUntitled) {
        path = new Path(document.uri);
        file = path.pop();
      }
      active = Some(new AdvancedFile(path, file));

      setContext(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("advanced-file.stepIn", () =>
      active.ifSome((active) => active.stepIn())
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("advanced-file.stepOut", () =>
      active.ifSome((active) => active.stepOut())
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("advanced-file.actions", () =>
      active.ifSome((active) => active.actions())
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("advanced-file.tabNext", () =>
      active.ifSome((active) => active.tabCompletion(true))
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("advanced-file.tabPrev", () =>
      active.ifSome((active) => active.tabCompletion(false))
    )
  );
};
