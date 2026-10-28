import type { BotComment, Review } from "../src/types";

type Expected =
  | { kind: "finding"; description: string; path: string; lines: [number, number]; evidence: RegExp[] }
  | { kind: "clean" | "unresolved" | "fixed"; description: string };

export type Case = {
  name: string;
  before: Record<string, string>;
  after: Record<string, string>;
  message: string;
  open?: BotComment;
  expected: Expected;
};

const quota = (comparison: string) => `export function reserve(used: number, requested: number, limit: number) {
  if (used + requested ${comparison} limit) throw new Error("Quota exceeded");
  return used + requested;
}
`;
const open: BotComment = {
  id: 73, review: 1, user: "reviewer", path: "quota.ts", line: 2, side: "RIGHT",
  body: "**blocking:** When used=8, requested=2 and limit=10, this rejects a reservation exactly at the limit. Reject only totals greater than limit.",
  resolved: false, at: "2026-01-01T00:00:00Z",
};

export const cases: Case[] = [
  {
    name: "Cross-file expiry units",
    expected: {
      kind: "finding",
      description: "expiry.ts:2 must block: callers pass seconds, so adding them to Date.now() expires sessions 1000 times too soon.",
      path: "expiry.ts", lines: [1, 2],
      evidence: [/openSession|sessions\.ts|ttlSeconds/i, /\bseconds?\b/i, /milli|1[,_]?000|Date\.now/i, /expir|too soon|early|short/i],
    },
    before: {
      "expiry.ts": `export function expiry(ttl: number) {
  return Date.now() + ttl * 1000;
}
`,
      "sessions.ts": `import { expiry } from "./expiry";

export function openSession(ttlSeconds: number) {
  return { expiresAt: expiry(ttlSeconds) };
}

export function isActive(session: { expiresAt: number }) {
  return session.expiresAt > Date.now();
}
`,
    },
    after: {
      "expiry.ts": `export function expiry(ttl: number) {
  return Date.now() + ttl;
}
`,
    },
    message: "Shorten expiry calculation",
  },
  {
    name: "Deliberate ownership bypass",
    expected: {
      kind: "finding",
      description: "permissions.ts:5 must block: a member can delete another member's document despite the author's deliberate role-only check.",
      path: "permissions.ts", lines: [4, 5],
      evidence: [/member|non.admin|regular|signed.in/i, /other|another|not.{0,20}own|unowned/i, /delet|remov/i],
    },
    before: {
      "README.md": "# Documents\n\nOnly a document's owner or an admin may delete it.\n",
      "permissions.ts": `type User = { id: string; role: "admin" | "member" };
type Document = { ownerId: string };

export function canDelete(user: User, document: Document) {
  return user.role === "admin" || user.id === document.ownerId;
}
`,
    },
    after: {
      "permissions.ts": `type User = { id: string; role: "admin" | "member" };
type Document = { ownerId: string };

export function canDelete(user: User, document: Document) {
  return user.role === "admin" || user.role === "member";
}
`,
    },
    message: "Use role checks for document deletion\n\nIntentionally treat signed-in members as trusted here to avoid an ownership comparison. Deletion remains behind the role gate.",
  },
  {
    name: "Clean blank-name handling",
    expected: {
      kind: "clean",
      description: "looks-good, no comments or addressed findings: trimming names before the anonymous fallback is safe.",
    },
    before: {
      "profile.ts": `export function displayName(name: string) {
  return name || "Anonymous";
}
`,
    },
    after: {
      "profile.ts": `export function displayName(name: string) {
  return name.trim() || "Anonymous";
}
`,
    },
    message: "Treat blank display names as anonymous",
  },
  {
    name: "Incremental unresolved quota finding",
    expected: {
      kind: "unresolved",
      description: "blocking, no duplicate comments, no addressed findings: the open exact-limit rejection remains in quota.ts:2.",
    },
    before: {
      "quota.ts": quota(">="),
      "profile.ts": `export function displayName(name: string) {
  return name || "Anonymous";
}
`,
    },
    after: {
      "profile.ts": `export function displayName(name: string) {
  return name.trim() || "Anonymous";
}
`,
    },
    message: "Treat blank display names as anonymous",
    open,
  },
  {
    name: "Incremental fixed quota finding",
    expected: {
      kind: "fixed",
      description: "looks-good, no comments, address comment 73 with the new commit SHA: exact-limit reservations now succeed.",
    },
    before: { "quota.ts": quota(">=") },
    after: { "quota.ts": quota(">") },
    message: "Allow reservations equal to the quota limit",
    open,
  },
];

export function score(testCase: Case, review: Review, head: string): string[] {
  const failures: string[] = [];
  const expected = testCase.expected;
  const recommendation = expected.kind === "finding" || expected.kind === "unresolved" ? "blocking" : "looks-good";
  if (review.recommendation !== recommendation) {
    failures.push(`Expected recommendation ${recommendation}, got ${review.recommendation}`);
  }
  if (expected.kind === "finding") {
    const matches = review.comments.filter((comment) =>
      comment.path === expected.path && comment.side === "RIGHT" &&
      comment.line >= expected.lines[0] && comment.line <= expected.lines[1] &&
      comment.severity === "blocking" && expected.evidence.every((pattern) => pattern.test(comment.body)),
    );
    if (matches.length !== 1) failures.push(`Expected one blocking finding at ${expected.path}:${expected.lines.join("-")} with evidence ${expected.evidence.join(", ")}; got ${matches.length}`);
    for (const comment of review.comments) {
      if (!matches.includes(comment)) failures.push(`Unexpected finding (false positive or wrong evidence): ${comment.path}:${comment.line}: ${comment.body}`);
    }
  } else {
    for (const comment of review.comments) {
      failures.push(`Unexpected finding (false positive or duplicate): ${comment.path}:${comment.line}: ${comment.body}`);
    }
  }
  if (expected.kind === "fixed") {
    if (review.addressed.length !== 1 || review.addressed[0]?.commentId !== testCase.open?.id ||
      !/^[0-9a-f]{7,40}$/.test(review.addressed[0]?.sha ?? "") || !head.startsWith(review.addressed[0]?.sha ?? "")) {
      failures.push(`Expected only comment ${testCase.open?.id} addressed by ${head}, got ${JSON.stringify(review.addressed)}`);
    }
  } else if (review.addressed.length) {
    failures.push(`Unexpected addressed findings: ${JSON.stringify(review.addressed)}`);
  }
  return failures;
}
