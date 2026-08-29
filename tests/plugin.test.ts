/**
 * Tests run against the plugin object directly — no CMS, no database.
 * `makeTestContext` stubs only the slice of PluginContext the code under
 * test touches; grow it as the plugin grows.
 */

import { beforeEach, describe, expect, it } from "vitest";

import plugin from "../src/plugin.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Test doubles ─────────────────────────────────────────────────────────

interface Row {
	id: string;
	data: Record<string, unknown>;
}

function makeTestContext(rows: Row[] = [], settings: Record<string, unknown> = {}) {
	const store = new Map<string, Record<string, unknown>>(rows.map((r) => [r.id, r.data]));
	const kv = new Map<string, unknown>(
		Object.entries(settings).map(([k, v]) => [`settings:${k}`, v]),
	);

	const tracked = {
		get: async (id: string) => store.get(id) ?? null,
		put: async (id: string, data: Record<string, unknown>) => {
			store.set(id, data);
		},
		delete: async (id: string) => store.delete(id),
		exists: async (id: string) => store.has(id),
		count: async (where?: Record<string, unknown>) =>
			[...store.values()].filter((d) => !where?.status || d.status === where.status).length,
		// Minimal stand-in for the real query engine: supports the
		// `status` equality and `updatedAt: { lt }` range the plugin uses.
		query: async (options?: {
			where?: Record<string, unknown>;
			orderBy?: Record<string, "asc" | "desc">;
			limit?: number;
		}) => {
			const where = options?.where ?? {};
			let items = [...store.entries()].map(([id, data]) => ({ id, data }));

			if (typeof where.status === "string") {
				items = items.filter((i) => i.data.status === where.status);
			}
			const updatedAt = where.updatedAt as { lt?: string } | undefined;
			if (updatedAt?.lt) {
				items = items.filter((i) => String(i.data.updatedAt) < updatedAt.lt!);
			}
			items.sort((a, b) => String(a.data.updatedAt).localeCompare(String(b.data.updatedAt)));
			return { items: items.slice(0, options?.limit ?? 50), cursor: undefined, hasMore: false };
		},
	};

	const ctx = {
		plugin: { id: "premium-starter", version: "0.1.0" },
		storage: { tracked },
		kv: {
			get: async <T>(k: string) => (kv.has(k) ? (kv.get(k) as T) : null),
			set: async (k: string, v: unknown) => {
				kv.set(k, v);
			},
			delete: async (k: string) => kv.delete(k),
			list: async (prefix = "") =>
				[...kv.entries()]
					.filter(([k]) => k.startsWith(prefix))
					.map(([key, value]) => ({ key, value })),
		},
		log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
	} as unknown as import("@premium-cms/emdash").PluginContext;

	return { ctx, store, kv };
}

function daysAgo(n: number): string {
	return new Date(Date.now() - n * DAY_MS).toISOString();
}

function published(collection: string, title: string, ageDays: number) {
	return {
		updatedAt: daysAgo(ageDays),
		collection,
		status: "published",
		title,
		slug: title.toLowerCase().replace(/\s+/g, "-"),
	};
}

async function callAdmin(ctx: import("@premium-cms/emdash").PluginContext, input: unknown) {
	const route = plugin.routes?.admin;
	if (!route || typeof route !== "object" || !("handler" in route)) {
		throw new Error("admin route not found");
	}
	return route.handler({ input } as never, ctx);
}

async function callSave(
	ctx: import("@premium-cms/emdash").PluginContext,
	event: Record<string, unknown>,
): Promise<void> {
	const hook = plugin.hooks?.["content:afterSave"];
	if (!hook || typeof hook !== "object" || !("handler" in hook)) {
		throw new Error("content:afterSave hook not found");
	}
	await hook.handler(event as never, ctx);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("content:afterSave", () => {
	it("tracks a saved item under <collection>:<id>", async () => {
		const { ctx, store } = makeTestContext();
		await callSave(ctx, {
			collection: "posts",
			isNew: true,
			content: { id: "42", slug: "hello", status: "published", data: { title: "Hello" } },
		});

		const row = store.get("posts:42");
		expect(row).toBeDefined();
		expect(row).toMatchObject({ collection: "posts", status: "published", title: "Hello" });
	});

	it("accepts numeric ids", async () => {
		const { ctx, store } = makeTestContext();
		await callSave(ctx, {
			collection: "posts",
			isNew: true,
			content: { id: 7, slug: "seven", status: "published", data: {} },
		});
		expect(store.has("posts:7")).toBe(true);
	});

	it("skips collections outside the configured scope", async () => {
		const { ctx, store } = makeTestContext([], { collections: "posts" });
		await callSave(ctx, {
			collection: "pages",
			isNew: true,
			content: { id: "1", slug: "about", status: "published", data: {} },
		});
		expect(store.size).toBe(0);
	});

	it("records nothing while tracking is disabled", async () => {
		const { ctx, store } = makeTestContext([], { enabled: false });
		await callSave(ctx, {
			collection: "posts",
			isNew: true,
			content: { id: "1", slug: "x", status: "published", data: {} },
		});
		expect(store.size).toBe(0);
	});
});

describe("content:afterDelete", () => {
	it("removes the tracked row", async () => {
		const { ctx, store } = makeTestContext([
			{ id: "posts:1", data: published("posts", "Gone", 100) },
		]);
		const hook = plugin.hooks?.["content:afterDelete"];
		if (!hook || typeof hook !== "object" || !("handler" in hook)) throw new Error("no hook");
		await hook.handler({ collection: "posts", id: "1" } as never, ctx);
		expect(store.has("posts:1")).toBe(false);
	});
});

describe("stale route", () => {
	let ctx: import("@premium-cms/emdash").PluginContext;

	beforeEach(() => {
		ctx = makeTestContext([
			{ id: "posts:1", data: published("posts", "Ancient", 90) },
			{ id: "posts:2", data: published("posts", "Fresh", 2) },
			{ id: "pages:3", data: published("pages", "Old page", 60) },
			{
				id: "posts:4",
				data: { ...published("posts", "Draft", 200), status: "draft" },
			},
		]).ctx;
	});

	async function callStale(context = ctx, url = "https://example.com/stale") {
		const route = plugin.routes?.stale;
		if (!route || typeof route !== "object" || !("handler" in route)) throw new Error("no route");
		return (await route.handler({ request: { url } } as never, context)) as {
			items: Array<{ title: string; staleForDays: number }>;
			staleAfterDays: number;
		};
	}

	it("returns only published items past the threshold", async () => {
		const result = await callStale();
		const titles = result.items.map((i) => i.title);
		expect(titles).toContain("Ancient");
		expect(titles).toContain("Old page");
		expect(titles).not.toContain("Fresh");
		expect(titles).not.toContain("Draft");
	});

	it("orders oldest first and reports age in days", async () => {
		const result = await callStale();
		expect(result.items[0].title).toBe("Ancient");
		expect(result.items[0].staleForDays).toBeGreaterThanOrEqual(89);
	});

	it("honours a custom threshold", async () => {
		const scoped = makeTestContext(
			[
				{ id: "posts:1", data: published("posts", "Ancient", 90) },
				{ id: "posts:2", data: published("posts", "Fresh", 2) },
			],
			{ staleAfterDays: 1 },
		).ctx;
		const result = await callStale(scoped);
		expect(result.staleAfterDays).toBe(1);
		expect(result.items).toHaveLength(2);
	});
});

describe("settings", () => {
	it("falls back to defaults when nothing is stored", async () => {
		const { ctx } = makeTestContext();
		const route = plugin.routes?.settings;
		if (!route || typeof route !== "object" || !("handler" in route)) throw new Error("no route");
		expect(await route.handler({} as never, ctx)).toEqual({
			staleAfterDays: 30,
			collections: "all",
			enabled: true,
		});
	});

	it("ignores a non-positive threshold rather than storing junk", async () => {
		const { ctx, kv } = makeTestContext([], { staleAfterDays: 30 });
		await callAdmin(ctx, {
			type: "form_submit",
			action_id: "save_settings",
			values: { staleAfterDays: -5 },
		});
		expect(kv.get("settings:staleAfterDays")).toBe(30);
	});

	it("persists a valid threshold from the admin form", async () => {
		const { ctx, kv } = makeTestContext();
		await callAdmin(ctx, {
			type: "form_submit",
			action_id: "save_settings",
			values: { staleAfterDays: 14, collections: "posts", enabled: false },
		});
		expect(kv.get("settings:staleAfterDays")).toBe(14);
		expect(kv.get("settings:collections")).toBe("posts");
		expect(kv.get("settings:enabled")).toBe(false);
	});
});

describe("admin route", () => {
	it("renders the freshness page with a table and a settings form", async () => {
		const { ctx } = makeTestContext([{ id: "posts:1", data: published("posts", "Ancient", 90) }]);
		const result = (await callAdmin(ctx, { type: "page_load", page: "/freshness" })) as {
			blocks: Array<Record<string, unknown>>;
		};
		const types = result.blocks.map((b) => b.type);
		expect(types).toContain("header");
		expect(types).toContain("table");
		expect(types).toContain("form");
	});

	it("renders the widget", async () => {
		const { ctx } = makeTestContext([{ id: "posts:1", data: published("posts", "Ancient", 90) }]);
		const result = (await callAdmin(ctx, {
			type: "page_load",
			page: "widget:stale-content",
		})) as { blocks: Array<Record<string, unknown>> };
		expect(result.blocks.length).toBeGreaterThan(0);
	});

	it("returns no blocks for an unknown interaction", async () => {
		const { ctx } = makeTestContext();
		expect(await callAdmin(ctx, { type: "nonsense" })).toEqual({ blocks: [] });
	});
});
