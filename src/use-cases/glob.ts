/**
 * Minimal, dependency-free glob matching for vault-relative paths.
 *
 * Supports `*` (within a path segment), `**` (across segments) and `?`.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // Swallow the slash after `**` so `**/x` also matches `x`.
        if (pattern[i + 1] === "/") i++;
        out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  out += "$";
  return new RegExp(out);
}

/** Return the subset of `paths` matching `pattern`. */
export function matchGlob(pattern: string, paths: string[]): string[] {
  const regex = globToRegExp(pattern);
  return paths.filter((path) => regex.test(path));
}
