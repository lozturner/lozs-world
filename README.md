# Loz's World 🌐✨

> A little Tron-room you can walk around in, fill with your own stuff, and use as a memory palace, a dashboard, a desk, a daydream.

![status](https://img.shields.io/badge/status-alive-00ffd0?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-1c1814?style=flat-square)
![license](https://img.shields.io/badge/license-personal-c2682c?style=flat-square)

## 🚀 Just want to try it?

**👉 [Download `LozsWorld.exe` from the latest release](https://github.com/lozturner/lozs-world/releases/latest)**

Double-click. Your browser opens. You're in. 🪩

No install, no Node, no dependencies, no setup. Windows might ask "allow this through Firewall?" — say yes (it's only listening on your own machine and your home Wi-Fi, not the wider internet).

---

## 💭 The story

I had a desk full of monitors and a head full of half-finished thoughts, and I kept wanting *one place* I could put everything — the websites I'm watching, the 3D bits I'm modelling, the loose ends. Not another app, not another tab. A **room**. Somewhere I could *walk into*.

So I built it. Loz's World is a tiny Tron-style 3D environment that runs on your own computer, opens in your browser, and lets you:

- 🖥️ **Hang up to five live websites on the walls as monitors.** Real, working sites. You can watch a YouTube stream while you work, dashboard your home assistant, pin Wikipedia next to a search bar, whatever. The server here strips the headers that normally stop a site from being framed, so the iframes actually load instead of showing the usual "this site cannot be embedded" wall.
- 🧊 **Drag any 3D model straight onto the world** — `.stl`, `.obj`, `.glb`, `.gltf`, `.fbx`, `.dae`, `.3ds`, `.ply`. Drop, see it, walk around it. Files land in the `assets/` folder next to the `.exe` and persist between sessions.
- 🚶 **Walk around in first-person.** WASD + mouse. The grid floor glows. The cyan light hums. It's silly and it's also weirdly calming.
- 🔍 **Open any website by typing it.** There's a search bar built in — type a URL, type a question, hit go. DuckDuckGo autocomplete runs server-side so the suggestions appear as fast as the desktop browser.
- 🧠 **Use it as a memory palace.** This is the bit I really wanted. Stick a model of a thing in a corner, hang the relevant document on the wall next to it. Come back tomorrow, walk to that corner, and the memory's *located* — the way human memory actually works.
- 📱 **Reach it from your phone or iPad** on the same Wi-Fi. The server prints a `loz.local` URL on startup. Stand up, pick up your tablet, and the room's still there.

It's a personal-scale toy. It's the desk I wanted.

---

## 🪄 What's in the box

| | |
|---|---|
| **3D engine** | [Three.js](https://threejs.org) (vendored, no CDN required) |
| **Server** | Node + Express, runs on `localhost:7777` |
| **Live monitors** | DOM iframes positioned via `CSS3DRenderer` so 3D math + DOM stay in sync |
| **Site embedding** | `/proxy` strips `X-Frame-Options` and CSP `frame-ancestors` |
| **Search** | DuckDuckGo autocomplete proxied server-side |
| **LAN access** | mDNS publishes `loz.local` so phones/iPads find it without an IP |
| **Self-update** | Live-reload on file change while developing |

---

## 🧰 If you want to run from source

You only need this if you want to hack on it. To *use* it, just grab the .exe.

```bash
git clone https://github.com/lozturner/lozs-world.git
cd lozs-world
npm install
npm start
```

Open http://localhost:7777.

To build a fresh `.exe`:

```bash
npm run build
# → dist/LozsWorld.exe
```

---

## 🔐 A note on the proxy

`/proxy?u=...` is what makes the live web monitors actually load anything. It also means anything you embed has its cookies briefly land on `localhost:7777` (or wherever you're running it). **Don't put authenticated personal accounts on a monitor** — keep banking, email, etc. in your normal browser. Pin public dashboards, news, video, references.

The proxy is gated by a same-origin cookie that the page sets on first load, so nobody who finds the URL can use it as an open web proxy without first visiting the world.

---

## 🛠️ Files of note

- [`server.js`](server.js) — Express server, proxy, search, LAN advertisement
- [`public/world.js`](public/world.js) — the 3D world itself (Three.js scene, monitors, drag-drop, controls)
- [`public/config.json`](public/config.json) — set the five default monitor URLs
- [`NOTES.md`](NOTES.md) — design decisions and the alternatives I considered

---

Built with 🖤 by [Loz](https://github.com/lozturner).
