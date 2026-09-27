import { z } from "zod";

export const Review = z.object({
  summary: z.string(),
  recommendation: z.enum(["blocking", "nits", "looks-good"]),
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number().int(),
      side: z.enum(["LEFT", "RIGHT"]),
      body: z.string(),
      severity: z.enum(["blocking", "nit"]),
    }),
  ),
  addressed: z.array(z.object({ commentId: z.number().int(), sha: z.string().regex(/^[0-9a-f]{7,40}$/) })),
});
export type Review = z.infer<typeof Review>;
export type Comment = Review["comments"][number];
export const Reply = z.object({ body: z.string() });
export type Reply = z.infer<typeof Reply>;

export const ForgejoUser = z.object({ login: z.string() });
export const ForgejoReview = z.object({ id: z.number(), user: ForgejoUser.nullable(), body: z.string() });
export const ForgejoReviewComment = z.object({
  id: z.number(),
  user: ForgejoUser.nullable(),
  path: z.string(),
  position: z.number(),
  original_position: z.number(),
  body: z.string(),
  resolver: ForgejoUser.nullable(),
});
export const ForgejoCreated = z.object({ id: z.number() });
export const ForgejoPull = z.object({ base: z.object({ sha: z.string() }), head: z.object({ sha: z.string() }) });

export type PR = { owner: string; repo: string; number: number };
export type Checkout = { dir: string; diff: string; log: string; rules: string; incremental?: boolean };
export type InlineComment = { path: string; body: string; new_position?: number; old_position?: number };
export type BotComment = { id: number; review: number; user: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string; resolved: boolean };
export type Thread = [BotComment, ...BotComment[]];

export type Forgejo = {
  login: string;
  react(pr: PR): Promise<void>;
  reactComment(pr: PR, comment: number): Promise<void>;
  pull(pr: PR): Promise<{ base: string; head: string }>;
  comment(pr: PR, body: string): Promise<void>;
  createReview(pr: PR, review: { event: "COMMENT"; body: string; comments: InlineComment[] }): Promise<void>;
  reviews(pr: PR): Promise<{ id: number; user: string; body: string }[]>;
  comments(pr: PR, review: number): Promise<BotComment[]>;
  reply(pr: PR, comment: BotComment, body: string): Promise<void>;
};
export type Git = {
  checkout(pr: PR, base: string, head: string, since?: string): Promise<Checkout>;
  remove(checkout: Checkout): Promise<void>;
};
export type Claude = {
  review(checkout: Checkout, large: boolean, open: BotComment[]): Promise<Review>;
  reply(checkout: Checkout, comment: string, thread?: Thread): Promise<Reply>;
};
export type Adapters = { forgejo: Forgejo; git: Git; claude: Claude };
