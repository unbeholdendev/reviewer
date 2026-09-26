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
});
export type Review = z.infer<typeof Review>;
export type Comment = Review["comments"][number];

export type PR = { owner: string; repo: string; number: number };
export type Checkout = { dir: string; diff: string; log: string; rules: string };
export type InlineComment = { path: string; body: string; new_position?: number; old_position?: number };

export type Forgejo = { createReview(pr: PR, review: { event: "COMMENT"; body: string; comments: InlineComment[] }): Promise<void> };
export type Git = { checkout(pr: PR, base: string, head: string): Promise<Checkout>; remove(checkout: Checkout): Promise<void> };
export type Claude = { review(checkout: Checkout, large: boolean): Promise<Review> };
export type Adapters = { forgejo: Forgejo; git: Git; claude: Claude };
