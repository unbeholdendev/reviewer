const lockfiles =
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|flake\.lock|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json)$/;
const vendored = /(^|\/)(vendor|node_modules|third_party)\//;

export function skipped(path: string) {
  return lockfiles.test(path) || vendored.test(path);
}

export function withoutSkipped(diff: string) {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((s) => !skipped(s.match(/^diff --git .* "?b\/(.*?)"?$/m)?.[1] ?? ""))
    .join("");
}

export function changedLines(diff: string) {
  return diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length;
}

// Forgejo only anchors comments on lines shown in a hunk
export function anchorable(diff: string) {
  const lines = new Set<string>();
  let path = "", left = 0, right = 0, inHunk = false;
  for (const l of diff.split("\n")) {
    const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (hunk) [left, right, inHunk] = [Number(hunk[1]), Number(hunk[2]), true];
    else if (l.startsWith("diff ")) [path, inHunk] = ["", false];
    else if (!inHunk) {
      if (l.startsWith("--- a/") || l.startsWith("+++ b/")) path = l.slice(6);
    } else if (l.startsWith("+")) lines.add(`RIGHT ${path}:${right++}`);
    else if (l.startsWith("-")) lines.add(`LEFT ${path}:${left++}`);
    else if (l.startsWith(" ")) lines.add(`LEFT ${path}:${left++}`).add(`RIGHT ${path}:${right++}`);
  }
  return lines;
}
