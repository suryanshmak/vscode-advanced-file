import * as vscode from "vscode";
import {
  Uri,
  WorkspaceFolder,
  FileStat,
  FileType,
  FileSystemError,
} from "vscode";
import * as OSPath from "path";
import { Option, None, Some, Result, Err, Ok } from "./rust";

export class Path {
  private pathUri: Uri;

  constructor(uri: Uri) {
    this.pathUri = uri;
  }

  static fromFilePath(filePath: string): Path {
    return new Path(Uri.file(filePath));
  }

  get uri(): Uri {
    return this.pathUri;
  }

  get id(): string {
    return this.pathUri.toString(false);
  }

  get fsPath(): string {
    return this.pathUri.fsPath;
  }

  clone(): Path {
    return new Path(this.pathUri);
  }

  equals(other: Path) {
    return this.id === other.id;
  }

  atTop(): boolean {
    return this.pathUri === Uri.joinPath(this.pathUri, "..");
  }

  root(): Uri {
    return this.pathUri.with({ path: "/" });
  }

  append(...pathSegments: string[]): Path {
    return new Path(Uri.joinPath(this.pathUri, ...pathSegments));
  }

  parent(): Path {
    return this.append("..");
  }

  // Push `pathSegments` onto the end of the path.

  push(...pathSegments: string[]) {
    this.pathUri = Uri.joinPath(this.pathUri, ...pathSegments);
  }

  // @returns [[None]] if the path has no more segments to pop.

  pop(): Option<string> {
    if (this.atTop()) {
      return None;
    }
    const current = new Path(this.pathUri);
    this.pathUri = Uri.joinPath(this.pathUri, "..");
    return current.relativeTo(this.pathUri);
  }

  getWorkspaceFolder(): Option<WorkspaceFolder> {
    return new Option(vscode.workspace.getWorkspaceFolder(this.pathUri));
  }

  relativeTo(other: Uri): Option<string> {
    if (
      this.pathUri.authority !== other.authority ||
      this.pathUri.scheme !== other.scheme
    ) {
      return None;
    }
    const relPath = OSPath.relative(other.fsPath, this.pathUri.fsPath);
    return Some(relPath);
  }

  async stat(): Promise<Result<FileStat, Error>> {
    //@ts-ignore
    return Result.try(vscode.workspace.fs.stat(this.pathUri));
  }

  async isDir(): Promise<boolean> {
    const stat = await this.stat();
    return stat.match(
      (stat) => !!(stat.type | FileType.Directory),
      () => false
    );
  }

  async isFile(): Promise<boolean> {
    const stat = await this.stat();
    return stat.match(
      (stat) => !!(stat.type | FileType.File),
      () => false
    );
  }
}

// If a string ends with a path separator, return the string with the path separator removed.
// Otherwise, return [[None]].

export function endsWithPathSeparator(value: string): Option<string> {
  if (value.endsWith("/")) {
    return Some(value.slice(0, value.length - 1));
  }
  if (value.endsWith(OSPath.sep)) {
    return Some(value.slice(0, value.length - OSPath.sep.length));
  }
  return None;
}

/**
 * Given a list of file names, try to find one of them in the provided path,
 * then step up one folder at a time and repeat the search until we find something
 * or run out of parents.
 *
 * If no file is found, we return [[FileSystemError.FileNotFound]].
 *
 * If `uri` points to a file, we immediately return [[FileSystemError.FileNotADirectory]].
 *
 * Returns either the [[Uri]] of the first file found, or [[None]].
 */

export async function lookUpwards(
  uri: Uri,
  files: string[]
): Promise<Result<Uri, FileSystemError>> {
  const path = new Path(uri);
  if (!(await path.isDir())) {
    return Err(FileSystemError.FileNotADirectory(uri));
  }
  while (true) {
    for (const file of files) {
      let filePath = path.append(file);
      if (await filePath.isFile()) {
        return Ok(filePath.uri);
      }
    }
    if (path.pop().isNone()) {
      return Err(FileSystemError.FileNotFound());
    }
  }
}
