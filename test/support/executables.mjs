import fs from "node:fs";
import path from "node:path";

export function resolveExecutable(name, incomingPath = process.env.PATH ?? "") {
  for (const directory of incomingPath.split(path.delimiter)) {
    const candidate = path.resolve(directory || ".", name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`Run tests require ${name} on the incoming PATH`);
}
