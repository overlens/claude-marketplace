---
name: events-lead-form
description: >
  Integrates a landing page's lead form with Overlens Events so every submitted lead reaches the
  Events API (and from there Google Sheets, Brevo, ManyChat, Meta Conversions API…). Use this
  skill whenever someone building or editing a landing page (LP) wants its form connected to
  Overlens Events, or whenever you are creating an LP form in an Overlens project and the leads
  must be captured. Triggers on phrases like "integrate the form with Events", "send leads to
  Events", "connect the LP to Overlens Events", "lead form webhook", "@overlens/events-sdk",
  "submitLead", "events.overlens", and Portuguese equivalents: "integrar o form com o Events",
  "mandar os leads pro Events", "conectar a LP no Events", "captação de leads da LP", "integrar
  formulário da landing page". Works on any stack — plain HTML without a bundler, Next.js, Vite +
  React, Astro, Vue, Svelte — using the official browser SDK. It ships the code wired to an
  environment variable and ends with a ready-to-send message asking the Events team for the
  values only they have (the trigger URL, the allowed origin, the Meta Pixel event name).
---

# Overlens Events — Lead Form Integration

You are wiring a landing page's lead form to **Overlens Events**. The person asking is very likely
a **designer or marketer, not a developer**: you do all the technical work, explain in plain
language, and finish with a clear list of what they must ask the Events team for.

## Ground rules

1. **Speak the user's language.** This file is in English; talk to the user in whatever language
   they write (pt-BR for Brazilian users). The hand-off message for the Events team (Step 7) is
   always in **pt-BR**.
2. **Never invent values only the team has.** The trigger URL (which contains the trigger *slug*),
   the allowlisted origins and the Meta event name come from the Events team. Do not guess a slug,
   do not hardcode `https://events.overlens.com.br/...`, do not paste an example URL as if it were
   real. Wire the code to an environment variable (or one clearly marked constant on plain-HTML
   pages) and leave it empty.
3. **Never break the form.** The SDK's `submitLead` never throws, but your glue code can. The
   form's existing behavior (validation, thank-you message, redirect, other destinations such as
   an Apps Script or a `dataLayer.push`) must keep working exactly as before, including when the
   Events variable is empty.
4. **Use the SDK, not a hand-written `fetch`.** `@overlens/events-sdk` owns the `eventId`
   (idempotency + Meta dedup), UTM and `fbclid` capture, the `_fbp`/`_fbc` cookies, the
   `text/plain` + `keepalive` POST and retries. Re-implementing any of that is a bug.
5. **Explain before doing.** One plain sentence before each install or file edit
   ("Vou instalar a biblioteca do Events no projeto, que é quem envia os leads").

## How Events receives a lead (context for you, not for the user)

- The SDK posts to `{endpoint}/webhooks/leads/{triggerSlug}`. The Events dashboard shows this as a
  single **trigger URL**, e.g. `https://<api-host>/webhooks/leads/<slug>` — that full URL is what
  the team hands over. The code splits it into `endpoint` (the URL origin) and `triggerSlug` (the
  last path segment).
- Only `email` is required. `name` and `phone` are optional (empty values are dropped).
- The hidden honeypot input **must be named `website`**. Bots fill it; the server silently
  discards those leads.
- The LP's origin (scheme + host, e.g. `https://lp.example.com`) must be in the Events allowlist,
  otherwise the API answers `403 invalid_origin`. `www.` and every subdomain are distinct
  origins; a wildcard like `https://*.example.com` covers subdomains but not the bare domain.
- A lead sent before the team creates the workflow is **not lost**: it is stored as `unmatched`
  and processed once the trigger exists.

## Step 1 — Inspect the project (silently)

Read the repo before asking anything. Determine:

- **Stack**: `package.json` dependencies (`next`, `vite`, `astro`, `react`, `vue`, `svelte`,
  `@sveltejs/kit`, `nuxt`…), or no `package.json` at all (plain HTML/CSS/JS).
- **Package manager**: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb`/`bun.lock` → bun,
  `package-lock.json` → npm.
- **Every lead form**: `<form>` elements or form components with an email field. LPs often have
  more than one (hero + footer, a modal, a quiz). List them all.
- **Current submit behavior** of each form: shows a message? redirects (checkout, WhatsApp,
  thank-you page)? already posts somewhere (Apps Script, RD Station, `dataLayer.push`, another
  webhook)?
- **Meta Pixel**: a `fbq(` call or the Pixel base code in the page → Pixel in code. A GTM snippet
  (`googletagmanager.com/gtm.js`) with no `fbq` → Pixel probably fires via GTM.
- **Consent banner / CMP** that gates marketing tags.
- **Hosting hints**: `vercel.json`, `netlify.toml`, `wrangler.toml`, `.github/workflows` — you
  will tell the user where the environment variable goes.

Only ask the user something if the repo cannot answer it (e.g. "esse formulário do rodapé também
deve mandar lead para o Events?"). One question at a time.

## Step 2 — Install the SDK

First check the latest published version:

```bash
npm view @overlens/events-sdk version
```

- **Project with `package.json`** → install with the project's package manager, e.g.
  `pnpm add @overlens/events-sdk`.
- **No bundler (plain HTML)** → load the IIFE build from jsDelivr, **pinned to the exact version**
  you just read (fallback `0.1.0` if the command is unavailable):

  ```html
  <script src="https://cdn.jsdelivr.net/npm/@overlens/events-sdk@0.1.0/dist/index.global.js"></script>
  ```

  It exposes `window.OverlensEvents` (`createEventsClient`, `metaPixel`, `dataLayer`).

## Step 3 — Configure the trigger URL

Create **one** variable holding the full trigger URL. Name it per stack so it reaches the browser:

| Stack | Variable | Read it with |
|---|---|---|
| Next.js | `NEXT_PUBLIC_EVENTS_LEAD_URL` | `process.env.NEXT_PUBLIC_EVENTS_LEAD_URL` |
| Vite (React/Vue/Svelte) | `VITE_EVENTS_LEAD_URL` | `import.meta.env.VITE_EVENTS_LEAD_URL` |
| Astro | `PUBLIC_EVENTS_LEAD_URL` | `import.meta.env.PUBLIC_EVENTS_LEAD_URL` |
| SvelteKit | `PUBLIC_EVENTS_LEAD_URL` | `$env/static/public` |
| Nuxt | `NUXT_PUBLIC_EVENTS_LEAD_URL` | `useRuntimeConfig().public.eventsLeadUrl` |
| Plain HTML | constant `EVENTS_LEAD_URL` at the top of the integration script | — |

- Add it **empty** to `.env.example` (create the file if the project has none) and to `.env` /
  `.env.local` if one exists and is git-ignored. Never commit a real value into a tracked `.env`.
- If the project already has a TypeScript env declaration (`vite-env.d.ts`, `env.d.ts`), add the
  variable to it.
- These are **build-time** variables on Next.js/Vite/Astro: changing them in the hosting panel
  requires a **redeploy**. You will say this in the hand-off.

## Step 4 — Create the client once, at page load

Write a tiny module (e.g. `src/lib/events.ts`, or an inline `<script>` on plain HTML) that:

1. Reads the variable.
2. If it is empty or not a valid URL → returns `null` (integration off, form unaffected). Log a
   `console.warn` only in development.
3. Splits the URL: `endpoint = url.origin`, `triggerSlug = last non-empty path segment`.
4. Calls `createEventsClient({ endpoint, triggerSlug, adapters })` **once, at module/page load —
   never inside the submit handler**: UTMs and `fbclid` are captured at creation, while the
   landing URL still has its query string.

Adapters:
- Pixel in the page code (`fbq`) → `adapters: [metaPixel()]`, wrapped with
  `when: () => <consent check>` if a CMP exists.
- Pixel via GTM, or no Pixel → **no adapter**. Do not migrate an existing `dataLayer.push` to the
  `dataLayer()` adapter unless the user explicitly asks — it changes what GTM tags receive. Mention
  it in the hand-off instead.
- Never use `metaPixel()` and `dataLayer()` together.

Copy-paste templates for each stack are in [references/stacks.md](references/stacks.md). Read the
section for the detected stack before writing code.

## Step 5 — Wire each form

For every lead form found in Step 1:

1. **Add the honeypot** if missing — an input named exactly `website`, hidden off-screen (not
   `type="hidden"`, not only `display:none`, which smart bots skip), `tabindex="-1"`,
   `autocomplete="off"`, `aria-hidden="true"`. Template in `references/stacks.md`.
2. **Map the fields**: `email` (required), `name`, `phone`, `honeypot: <website input value>`. If
   the form splits first/last name, join them with a space into `name`. Extra fields (company,
   quiz answers) are not part of the contract — leave them in the LP's other destinations.
3. **Call `submitLead` after the form's own validation passes**, alongside — not instead of —
   whatever the form already does:
   - **Form navigates away right after** (checkout, WhatsApp, thank-you page): call
     `events.submitLead(...)` **without awaiting it**, then navigate as before. The POST uses
     `keepalive` and Pixel adapters run synchronously before the request, so nothing is lost by
     the navigation. Do not add delays.
   - **Form stays on the page** (inline success message): `await` it, then show the existing
     success state. If Events is the form's **only** destination and the result is
     `status === "failed"`, show the form's error state with a "try again" option — a resubmit
     reuses the same `eventId`, so it can never duplicate the lead. If the form has another
     primary destination, do not surface Events failures to the visitor; `console.warn` them.
4. **Never** block the submit button forever, swallow the form's existing handler, or call
   `preventDefault()` on a form that previously relied on its native `action` without
   reproducing that navigation.
5. Double clicks are already handled by the SDK (same promise, one request); keep any existing
   button-disabling logic.

## Step 6 — Verify locally

- Run the project's build and typecheck/lint (`pnpm build`, `tsc --noEmit`…) and fix what you
  broke.
- With the variable **empty**: the form must behave exactly as before. Confirm by reading the
  code path (or by running the dev server if it is cheap to do).
- With a **placeholder** value (e.g. `https://example.invalid/webhooks/leads/test`) in a local,
  untracked env file: start the dev server and check in DevTools → Network that submitting sends
  a `POST` to `/webhooks/leads/test` with `Content-Type: text/plain`. A network error is expected —
  the point is that the request is built. Remove the placeholder afterwards.
- Do **not** test against the real Events API from `localhost`: the origin is not allowlisted and
  the answer will be `403 invalid_origin` — that is expected, not a bug.

Result codes and error strings: [references/troubleshooting.md](references/troubleshooting.md).

## Step 7 — Hand off (always, even if the user did not ask)

End with a short summary for the user, in their language, containing:

1. **What was done** — files changed, forms wired, honeypot added, Pixel adapter or not.
2. **What is still missing and who provides it** — tell them to contact the **Events team** and
   give them the pt-BR message from [references/team-request.md](references/team-request.md),
   filled with everything you already know (LP name, every production domain you could find,
   forms, whether there is a Pixel in code or via GTM, destinations they mentioned). Leave
   unknowns as clearly marked blanks for the user to complete.
3. **What to do when the team answers** — where to paste the trigger URL (the exact variable name
   and the hosting panel you detected, e.g. "Vercel → Settings → Environment Variables, escopo
   Production"), and that a **redeploy** is required for the change to take effect.
4. **How to confirm it works in production** — the smoke test from `references/troubleshooting.md`
   (submit with UTMs, check the POST in DevTools → Network, ask the team to confirm the lead
   appeared in Events).

Keep it short and concrete. The user should be able to forward the team message without editing
anything except the blanks.
