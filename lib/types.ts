import { z } from "azot/v2";

export const contentMetadataSchema = z.object({
  name: z.string(),
  seasons_count: z.number(),
});

export const seasonMetadataSchema = z.array(z.object({ number: z.number() }));

export const videoInfoResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      season: z.number().optional(),
      episode: z.number().optional(),
    }),
  ),
  has_next: z.boolean().optional(),
});

export const playOptionsSchema = z.object({
  video_balancer: z.object({ default: z.string().nullish() }).nullish(),
  extended_balancer: z
    .record(
      z.string(),
      z.object({
        balancer_url: z.string(),
        license_url: z.string().optional(),
      }),
    )
    .nullish(),
  detail: z.object({ languages: z.array(z.object({ title: z.string() })).optional() }).optional(),
});
