export enum Action {
  NewFile,
  NewFolder,
  OpenFile,
  OpenFileBeside,
  RenameFile,
  DeleteFile,
  OpenFolder,
  JumpToLine,
  OpenFolderInNewWindow,
}

export function action(label: string, action: Action) {
  return {
    label,
    name: "",
    action,
    alwaysShow: true,
  };
}
