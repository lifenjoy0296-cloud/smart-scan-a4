import { v } from "convex/values";
import { mutation, action } from "./_generated/server";
import { api } from "./_generated/api";

export const generateUploadUrl = mutation(async (ctx) => {
    return await ctx.storage.generateUploadUrl();
});

export const saveImage = mutation({
    args: {
        requestId: v.id("requests"),
        storageId: v.string(),
        location: v.string(),
        refType: v.string(),
    },
    handler: async (ctx, args) => {
        await ctx.db.insert("images", {
            requestId: args.requestId,
            storageId: args.storageId,
            location: args.location,
            refType: args.refType,
        });
    },
});

export const updateImageResult = mutation({
    args: {
        imageId: v.id("images"),
        width: v.optional(v.float64()),
        height: v.optional(v.float64()),
    },
    handler: async (ctx, args) => {
        const { imageId, ...updates } = args;
        await ctx.db.patch(imageId, updates);
    },
});

// Dummy AI Detection Action
export const analyzeImage = action({
    args: { imageId: v.id("images") },
    handler: async (ctx, args) => {
        // In a real scenario, you'd fetch the image data and run a model
        // Here we just return a dummy box in the center as in the Python version
        return {
            success: true,
            box: {
                x: 500, // Dummy absolute coords
                y: 400,
                w: 200,
                h: 150
            }
        };
    },
});
