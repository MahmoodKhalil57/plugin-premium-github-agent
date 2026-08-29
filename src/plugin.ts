/**
 * Content Freshness — the PremiumCMS reference plugin.
 *
 * This is the plugin every other PremiumCMS plugin should be read against.
 * It is deliberately small but touches every extension point a real plugin
 * uses, so copying it gives you a correct skeleton rather than a toy:
 *
 *   hooks     content:afterSave / content:afterDelete keep a lightweight
 *             index of when each published item last changed.
 *   storage   the `tracked` collection declared in emdash-plugin.jsonc.
 *   kv        `settings:*` keys hold user configuration.
 *   routes    JSON routes for programmatic callers, plus the special
 *             `admin` route that renders Block Kit for the admin UI.
 *   admin     a full page (/freshness) and a dashboard widget, both driven
 *             by `page_load` interactions on the `admin` route.
 *
 * What it does: whenever content is saved it records the timestamp. Anything
 * published and untouched for longer than the configured threshold is
 * reported as "stale" so editors know what needs a review pass.
 *
 * A note on the type annotation. EmDash's own in-repo plugins write
 * `export default { ... } satisfies SandboxedPlugin`. That works inside the
 * EmDash monorepo but fails in a standalone repo like this one: the emitted
 * .d.mts has to name `PluginStorageConfig`, whose only resolution path runs
 * through the package manager's internal store, and TypeScript rejects it
 * (TS2883). Annotating the const instead keeps every bit of the inference —
 * `event` is still narrowed per hook name, `ctx` is still a PluginContext —
 * while emitting declarations that are portable. Prefer this form here.
 */

import type { PluginContext, SandboxedPlugin } from "@premium-cms/emdash/plugin";

// ── Types ────────────────────────────────────────────────────────────────

/** One row in the `tracked` storage collection, keyed by `<collection>:<id>`. */
interface TrackedItem {
	/** ISO-8601. Indexed, so it can drive `orderBy` and range `where` clauses. */
	updatedAt: string;
	/** Indexed — lets the admin page filter to a single collection. */
	collection: string;
	/** Indexed — only `published` items are considered for staleness. */
	status: string;
	title: string;
	slug: string;
}

interface Settings {
	/** Days of inactivity before published content counts as stale. */
	staleAfterDays: number;
	/** Comma-separated collection slugs, or "all". */
	collections: string;
	enabled: boolean;
}

const DEFAULT_SETTINGS: Settings = {
	staleAfterDays: 30,
	collections: "all",
	enabled: true,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Content ids are strings or numbers depending on the database adapter.
 * Everything else collapses to "" so callers can skip the record with a
 * plain truthiness check rather than guarding each call site.
 */
function stringifyId(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

/**
 * Narrow an unknown field to a string.
 *
 * Worth internalising: a hook's `event.content` is typed
 * `Record<string, unknown>`, NOT a `ContentItem`. Every field read off it
 * — status, slug, title — is `unknown` and must be coerced before it can
 * be assigned to a typed field. Reaching for `event.content.status ?? ""`
 * looks right and fails to compile, because `unknown ?? string` is `{}`.
 */
function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function isTrackedItem(value: unknown): value is TrackedItem {
	return (
		isRecord(value) &&
		typeof value.updatedAt === "string" &&
		typeof value.collection === "string" &&
		typeof value.status === "string"
	);
}

function key(collection: string, id: string): string {
	return `${collection}:${id}`;
}

/**
 * Read settings, falling back to defaults for anything unset or of the
 * wrong type. Never throws: a failed KV read degrades to defaults so a
 * transient storage problem cannot take the admin page down with it.
 */
async function readSettings(ctx: PluginContext): Promise<Settings> {
	try {
		const entries = await ctx.kv.list("settings:");
		const map: Record<string, unknown> = {};
		for (const entry of entries) map[entry.key.replace("settings:", "")] = entry.value;

		const days = Number(map.staleAfterDays);
		return {
			staleAfterDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_SETTINGS.staleAfterDays,
			collections:
				typeof map.collections === "string" && map.collections.trim()
					? map.collections
					: DEFAULT_SETTINGS.collections,
			enabled: typeof map.enabled === "boolean" ? map.enabled : DEFAULT_SETTINGS.enabled,
		};
	} catch (error) {
		ctx.log.error("Failed to read settings; using defaults", error);
		return { ...DEFAULT_SETTINGS };
	}
}

/** True when `collection` is covered by the configured scope. */
function inScope(settings: Settings, collection: string): boolean {
	const raw = settings.collections.trim();
	if (!raw || raw === "all") return true;
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.includes(collection);
}

/**
 * Every published tracked item older than the threshold, newest first.
 *
 * The `where` clause filters on `status` and `updatedAt` — both declared as
 * indexes in the manifest. Querying an undeclared field is the single most
 * common mistake when adapting this plugin: add the index first.
 */
async function findStale(
	ctx: PluginContext,
	settings: Settings,
	limit = 50,
	cursor?: string,
): Promise<{ items: Array<{ id: string; data: TrackedItem }>; cursor?: string; hasMore: boolean }> {
	const cutoff = new Date(Date.now() - settings.staleAfterDays * DAY_MS).toISOString();

	const result = await ctx.storage.tracked!.query({
		where: { status: "published", updatedAt: { lt: cutoff } },
		orderBy: { updatedAt: "asc" },
		limit,
		cursor,
	});

	const items = result.items
		.filter((item): item is { id: string; data: TrackedItem } => isTrackedItem(item.data))
		.filter((item) => inScope(settings, item.data.collection));

	return { items, cursor: result.cursor, hasMore: result.hasMore };
}

/** Whole days since `iso`, floored at 0. */
function daysSince(iso: string): number {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return 0;
	return Math.max(0, Math.floor((Date.now() - then) / DAY_MS));
}

// ── Plugin definition ────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	hooks: {
		/**
		 * Lifecycle hooks fire on install/activate/deactivate/uninstall.
		 * Seeding defaults at install time means the admin page has real
		 * values to render before the user has saved anything.
		 */
		"plugin:install": async (_event, ctx) => {
			for (const [name, value] of Object.entries(DEFAULT_SETTINGS)) {
				if ((await ctx.kv.get(`settings:${name}`)) === null) {
					await ctx.kv.set(`settings:${name}`, value);
				}
			}
			ctx.log.info("Content freshness installed");
		},

		"plugin:uninstall": async (_event, ctx) => {
			ctx.log.info("Content freshness uninstalled");
		},

		/**
		 * Record the save. Hooks must never throw — an unhandled error here
		 * would surface as a failed save for the editor, so a tracking
		 * failure is logged and swallowed.
		 */
		"content:afterSave": {
			handler: async (event, ctx) => {
				const settings = await readSettings(ctx);
				if (!settings.enabled || !inScope(settings, event.collection)) return;

				const id = stringifyId(event.content.id);
				if (!id) return;

				const data = isRecord(event.content.data) ? event.content.data : {};
				const slug = asString(event.content.slug);
				const item: TrackedItem = {
					updatedAt: new Date().toISOString(),
					collection: event.collection,
					status: asString(event.content.status, "draft"),
					title: asString(data.title) || slug || id,
					slug,
				};

				try {
					await ctx.storage.tracked!.put(key(event.collection, id), item);
				} catch (error) {
					ctx.log.error("Failed to track content", error);
				}
			},
		},

		/** Drop the row so deleted content cannot be reported as stale. */
		"content:afterDelete": {
			handler: async (event, ctx) => {
				try {
					await ctx.storage.tracked!.delete(key(event.collection, event.id));
				} catch (error) {
					ctx.log.error("Failed to untrack content", error);
				}
			},
		},
	},

	routes: {
		/**
		 * `admin` is a reserved route name: the admin UI posts Block Kit
		 * interactions to it and renders whatever blocks come back. Dispatch
		 * on `type` first, then on `page` / `action_id`.
		 */
		admin: {
			handler: async (routeCtx, ctx) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					value?: string;
					values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load" && interaction.page === "/freshness") {
					return buildFreshnessPage(ctx, interaction.value);
				}
				if (interaction.type === "page_load" && interaction.page === "widget:stale-content") {
					return buildStaleWidget(ctx);
				}
				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					await saveSettings(ctx, interaction.values ?? {});
					return buildFreshnessPage(ctx);
				}
				if (interaction.type === "block_action" && interaction.action_id === "load-page") {
					return buildFreshnessPage(ctx, interaction.value);
				}
				return { blocks: [] };
			},
		},

		/** JSON: the stale list, for dashboards or scheduled reports. */
		stale: {
			handler: async (routeCtx, ctx) => {
				try {
					const url = new URL(routeCtx.request.url);
					const limit = Math.min(
						Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
						100,
					);
					const settings = await readSettings(ctx);
					const result = await findStale(
						ctx,
						settings,
						limit,
						url.searchParams.get("cursor") ?? undefined,
					);

					return {
						staleAfterDays: settings.staleAfterDays,
						items: result.items.map(({ id, data }) => ({
							id,
							...data,
							staleForDays: daysSince(data.updatedAt),
						})),
						cursor: result.cursor,
						hasMore: result.hasMore,
					};
				} catch (error) {
					ctx.log.error("Failed to list stale content", error);
					return { staleAfterDays: DEFAULT_SETTINGS.staleAfterDays, items: [], hasMore: false };
				}
			},
		},

		settings: {
			handler: async (_routeCtx, ctx) => readSettings(ctx),
		},

		"settings/save": {
			handler: async (routeCtx, ctx) => {
				try {
					await saveSettings(ctx, isRecord(routeCtx.input) ? routeCtx.input : {});
					return { success: true, settings: await readSettings(ctx) };
				} catch (error) {
					ctx.log.error("Failed to save settings", error);
					return { success: false, error: String(error) };
				}
			},
		},
	},
};

export default plugin;

// ── Settings persistence ─────────────────────────────────────────────────

/**
 * Writes only the keys present in `values`, and only when they carry a
 * usable value. Block Kit submits every field in the form, so a partial
 * or mistyped payload must not clobber good settings with junk.
 */
async function saveSettings(ctx: PluginContext, values: Record<string, unknown>): Promise<void> {
	const days = Number(values.staleAfterDays);
	if (Number.isFinite(days) && days > 0) {
		await ctx.kv.set("settings:staleAfterDays", Math.floor(days));
	}
	if (typeof values.collections === "string") {
		await ctx.kv.set("settings:collections", values.collections.trim() || "all");
	}
	if (typeof values.enabled === "boolean") {
		await ctx.kv.set("settings:enabled", values.enabled);
	}
}

// ── Block Kit builders ───────────────────────────────────────────────────
// Plain objects — no @premium-cms/blocks import needed, which keeps the
// sandbox bundle small and dependency-free.

async function buildFreshnessPage(ctx: PluginContext, cursor?: string) {
	try {
		const settings = await readSettings(ctx);
		const result = await findStale(ctx, settings, 50, cursor);
		const total = await ctx.storage.tracked!.count({ status: "published" });

		return {
			blocks: [
				{ type: "header", text: "Content Freshness" },
				{
					type: "context",
					text: settings.enabled
						? `Published content untouched for more than ${settings.staleAfterDays} days.`
						: "Tracking is currently disabled — new saves are not being recorded.",
				},
				{ type: "divider" },
				{
					type: "table",
					blockId: "stale-table",
					columns: [
						{ key: "title", label: "Title", format: "text" },
						{ key: "collection", label: "Collection", format: "badge" },
						{ key: "slug", label: "Slug", format: "code" },
						{ key: "updated", label: "Last updated", format: "relative_time" },
						{ key: "days", label: "Days stale", format: "text" },
					],
					rows: result.items.map(({ data }) => ({
						title: data.title,
						collection: data.collection,
						slug: data.slug || "-",
						updated: data.updatedAt,
						days: String(daysSince(data.updatedAt)),
					})),
					pageActionId: "load-page",
					nextCursor: result.cursor,
					emptyText: "Nothing is stale — every published item is within the threshold.",
				},
				{
					type: "context",
					text: `${result.items.length} stale of ${total} published items tracked`,
				},
				{ type: "divider" },
				{
					type: "form",
					block_id: "freshness-settings",
					fields: [
						{
							type: "number_input",
							action_id: "staleAfterDays",
							label: "Stale after (days)",
							initial_value: settings.staleAfterDays,
						},
						{
							type: "text_input",
							action_id: "collections",
							label: "Collections",
							placeholder: "all, or posts,pages",
							initial_value: settings.collections,
						},
						{
							type: "toggle",
							action_id: "enabled",
							label: "Track content changes",
							initial_value: settings.enabled,
						},
					],
					submit: { label: "Save settings", action_id: "save_settings" },
				},
			],
		};
	} catch (error) {
		ctx.log.error("Failed to build freshness page", error);
		return { blocks: [{ type: "context", text: "Failed to load content freshness." }] };
	}
}

async function buildStaleWidget(ctx: PluginContext) {
	try {
		const settings = await readSettings(ctx);
		const { items } = await findStale(ctx, settings, 4);

		if (items.length === 0) {
			return { blocks: [{ type: "context", text: "Nothing needs review." }] };
		}

		return {
			blocks: [
				{
					type: "fields",
					fields: items.map(({ data }) => ({
						label: data.title,
						value: `${data.collection} · ${daysSince(data.updatedAt)}d`,
					})),
				},
				{ type: "context", text: `Stale after ${settings.staleAfterDays} days` },
			],
		};
	} catch (error) {
		ctx.log.error("Failed to build stale widget", error);
		return { blocks: [{ type: "context", text: "Failed to load activity." }] };
	}
}
