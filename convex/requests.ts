import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const submit = mutation({
    args: {
        name: v.string(),
        phone: v.string(),
    },
    handler: async (ctx, args) => {
        const requestId = await ctx.db.insert("requests", {
            customer_name: args.name,
            phone: args.phone,
            status: "자료업로드",
            createdAt: Date.now(),
        });
        return requestId;
    },
});

export const list = query({
    args: {},
    handler: async (ctx) => {
        const requests = await ctx.db
            .query("requests")
            .withIndex("by_createdAt")
            .order("desc")
            .collect();

        return Promise.all(
            requests.map(async (r) => {
                const images = await ctx.db
                    .query("images")
                    .withIndex("by_requestId", (q) => q.eq("requestId", r._id))
                    .collect();
                return {
                    ...r,
                    imageCount: images.length,
                    firstImage: images[0]?.storageId,
                };
            })
        );
    },
});

export const getDetail = query({
    args: { requestId: v.id("requests") },
    handler: async (ctx, args) => {
        const request = await ctx.db.get(args.requestId);
        if (!request) return null;

        const images = await ctx.db
            .query("images")
            .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
            .collect();

        const imagesWithUrls = await Promise.all(
            images.map(async (img) => ({
                ...img,
                url: await ctx.storage.getUrl(img.storageId),
            }))
        );

        return {
            ...request,
            images: imagesWithUrls,
        };
    },
});

export const updateStatus = mutation({
    args: {
        requestId: v.id("requests"),
        status: v.optional(v.string()),
        memo: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const { requestId, ...updates } = args;
        await ctx.db.patch(requestId, updates);
    },
});
