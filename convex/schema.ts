import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
    requests: defineTable({
        customer_name: v.string(),
        phone: v.string(),
        status: v.string(), // "자료업로드", "분석완료", "견적완료"
        memo: v.optional(v.string()),
        createdAt: v.number(),
    }).index("by_createdAt", ["createdAt"]),

    images: defineTable({
        requestId: v.id("requests"),
        storageId: v.string(), // Convex Storage ID
        location: v.string(),
        refType: v.string(), // "A4", "CREDIT_CARD"
        width: v.optional(v.float64()),
        height: v.optional(v.float64()),
    }).index("by_requestId", ["requestId"]),
});
