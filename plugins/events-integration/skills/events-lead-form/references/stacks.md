# Stack templates

Adapt names and paths to the project's conventions (TypeScript vs JavaScript, `src/` layout,
existing `lib/` or `utils/` folder). Keep the behavior identical.

- [Shared pieces](#shared-pieces) — honeypot markup, URL parsing
- [Plain HTML (no bundler)](#plain-html-no-bundler)
- [Next.js (App Router or Pages Router)](#nextjs)
- [Vite + React](#vite--react)
- [Astro](#astro)
- [Vue / Nuxt / Svelte / SvelteKit](#vue--nuxt--svelte--sveltekit)

---

## Shared pieces

### Honeypot

Inside every lead `<form>`. The name **must** be `website`.

```html
<div class="ov-hp" aria-hidden="true">
  <label for="website">Website</label>
  <input type="text" id="website" name="website" tabindex="-1" autocomplete="off" />
</div>
```

```css
.ov-hp {
  position: absolute;
  left: -10000px;
  top: auto;
  width: 1px;
  height: 1px;
  overflow: hidden;
}
```

With Tailwind: `className="absolute -left-[10000px] h-px w-px overflow-hidden"`. If the page has
several forms, give each input a unique `id` (the `name` stays `website`). In JSX use `htmlFor`
and `tabIndex={-1}`.

### Trigger URL → client options

```ts
/** Splits the trigger URL the Events team provides into the SDK options. */
export function parseTriggerUrl(
  raw: string | undefined,
): { endpoint: string; triggerSlug: string } | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    const triggerSlug = url.pathname.split("/").filter(Boolean).pop();
    if (!triggerSlug || !url.pathname.includes("/webhooks/leads/")) return null;
    return { endpoint: url.origin, triggerSlug };
  } catch {
    return null;
  }
}
```

---

## Plain HTML (no bundler)

Place before `</body>`, after the form. Replace the version with the one from
`npm view @overlens/events-sdk version`. Adjust the selectors to the real form.

```html
<script src="https://cdn.jsdelivr.net/npm/@overlens/events-sdk@0.1.0/dist/index.global.js"></script>
<script>
  (function () {
    // Trigger URL provided by the Overlens Events team. Empty = integration off.
    var EVENTS_LEAD_URL = "";

    var events = null;
    try {
      if (EVENTS_LEAD_URL && window.OverlensEvents) {
        var url = new URL(EVENTS_LEAD_URL);
        var slug = url.pathname.split("/").filter(Boolean).pop();
        // Keep metaPixel() only if the page has Meta Pixel code; otherwise use [].
        var adapters = [OverlensEvents.metaPixel()];
        events = OverlensEvents.createEventsClient({
          endpoint: url.origin,
          triggerSlug: slug,
          adapters: adapters,
        });
      }
    } catch (e) {
      console.warn("[events] integration disabled:", e);
    }

    // Call this from the form's existing submit logic, after validation passes.
    window.sendLeadToEvents = function (form) {
      if (!events) return Promise.resolve(null);
      var data = new FormData(form);
      return events.submitLead({
        email: String(data.get("email") || ""),
        name: String(data.get("name") || ""),
        phone: String(data.get("phone") || ""),
        honeypot: String(data.get("website") || ""),
      });
    };
  })();
</script>
```

Hooking into an existing handler:

```js
form.addEventListener("submit", function (e) {
  e.preventDefault();
  // ...existing validation...
  window.sendLeadToEvents(form); // not awaited: the next line navigates
  window.location.href = CHECKOUT_URL; // existing behavior
});
```

`metaPixel()` looks up `window.fbq` at submit time and does nothing without it, so the order in
which the Pixel and this script load does not matter.

---

## Next.js

`src/lib/events.ts` (or `lib/events.ts`):

```ts
import { createEventsClient, metaPixel, type EventsClient } from "@overlens/events-sdk";

function parseTriggerUrl(raw: string | undefined) {
  /* see Shared pieces */
}

function createClient(): EventsClient | null {
  const options = parseTriggerUrl(process.env.NEXT_PUBLIC_EVENTS_LEAD_URL);
  if (!options) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[events] NEXT_PUBLIC_EVENTS_LEAD_URL is empty or invalid — leads are not sent.");
    }
    return null;
  }
  return createEventsClient({
    ...options,
    adapters: [metaPixel()], // only if the page has the Pixel in code; otherwise []
  });
}

/** Created once per page load. Safe during SSR: on the server it captures nothing. */
export const events = typeof window === "undefined" ? null : createClient();
```

The form component must be a Client Component (`"use client"`):

```tsx
"use client";

import { events } from "@/lib/events";

export function LeadForm() {
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    // ...existing validation...

    const result = await events?.submitLead({
      email: String(data.get("email") ?? ""),
      name: String(data.get("name") ?? ""),
      phone: String(data.get("phone") ?? ""),
      honeypot: String(data.get("website") ?? ""),
    });
    if (result?.status === "failed") console.warn("[events] lead not confirmed:", result.error);

    // ...existing success behavior (message / router.push / window.location)...
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* existing fields */}
      <div className="ov-hp" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input type="text" id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {/* submit button */}
    </form>
  );
}
```

If the form navigates away right after, drop the `await` (`void events?.submitLead(...)`).

If the project uses react-hook-form / Formik / zod: call `submitLead` inside the library's
`onSubmit` (which runs only after validation) with the validated values, and register the
honeypot as a plain uncontrolled input read from the form element or `getValues("website")`.

Do not call `submitLead` from a Server Action or Route Handler: it must run in the visitor's
browser, so Events gets their cookies, UTMs, IP and user agent.

---

## Vite + React

`src/lib/events.ts` — same as Next.js, reading `import.meta.env.VITE_EVENTS_LEAD_URL` and using
`import.meta.env.DEV` for the warning:

```ts
const options = parseTriggerUrl(import.meta.env.VITE_EVENTS_LEAD_URL);
if (!options && import.meta.env.DEV) console.warn("[events] VITE_EVENTS_LEAD_URL is empty or invalid.");
export const events = options ? createEventsClient({ ...options, adapters: [] }) : null;
```

Add to `src/vite-env.d.ts` if it declares `ImportMetaEnv`:

```ts
interface ImportMetaEnv {
  readonly VITE_EVENTS_LEAD_URL?: string;
}
```

The form component is the same as the Next.js one, minus `"use client"`. If the app uses
client-side routing and the LP is not the entry route, the module is still evaluated on first
import; UTMs are persisted last-touch in `localStorage`, so that is fine.

---

## Astro

`src/lib/events.ts` with `import.meta.env.PUBLIC_EVENTS_LEAD_URL`. Use it from a client-side
`<script>` in the component (Astro bundles and runs it in the browser once):

```astro
<form id="lead-form">
  <!-- fields + honeypot -->
</form>

<script>
  import { events } from "../lib/events";

  const form = document.getElementById("lead-form") as HTMLFormElement;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    await events?.submitLead({
      email: String(data.get("email") ?? ""),
      name: String(data.get("name") ?? ""),
      phone: String(data.get("phone") ?? ""),
      honeypot: String(data.get("website") ?? ""),
    });
    // existing behavior
  });
</script>
```

If the form is a React/Vue/Svelte island, follow that framework's section instead.

---

## Vue / Nuxt / Svelte / SvelteKit

Same pattern: a module that creates the client once (browser only), and the form's submit
handler calling `submitLead` after validation.

- **Vue + Vite**: `import.meta.env.VITE_EVENTS_LEAD_URL`; handler on `@submit.prevent`.
- **Nuxt**: declare `runtimeConfig.public.eventsLeadUrl` in `nuxt.config` (set by
  `NUXT_PUBLIC_EVENTS_LEAD_URL`); create the client in a `.client.ts` plugin and `provide` it.
- **Svelte + Vite**: `import.meta.env.VITE_EVENTS_LEAD_URL`; `on:submit|preventDefault` (Svelte 4)
  or `onsubmit` with `e.preventDefault()` (Svelte 5).
- **SvelteKit**: `import { PUBLIC_EVENTS_LEAD_URL } from "$env/static/public"`; guard creation
  with `import { browser } from "$app/environment"`. With form actions + `use:enhance`, call
  `submitLead` in the `enhance` callback before the request is submitted — never in the server
  action.
