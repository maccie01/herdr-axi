# Herdr 0.9.0 — Änderungsprotokoll und herdr-axi Impact-Analyse

Stand: 2026-09-08  
Maschine: `herdr 0.9.0` in `~/.local/bin/herdr` (ersetzt Homebrew 0.8.0)  
herdr-axi: `0.2.1` unter `/Users/studio/dev/tools/herdr-axi`

---

## 1. Kurzfassung

Herdr 0.9.0 ist ein Architektur-Release: Client-seitiges TUI, Multi-Client-Views, SSH-Maschinenverwaltung (`herdr machine`), schärfere Lifecycle-API und Breaking Changes bei Worktree-Group-Close und `--no-session`. Für herdr-axi bedeutet das:

- **Sofort:** Versions-Pin dokumentieren, `agent prompt --wait` und `agent read` Verhalten verifizieren, Lifecycle-Subscription-Semantik in Monitor/Hooks prüfen.
- **Kurzfristig:** Duplikat-Stack mit `ordex/dotfiles/herdr` konsolidieren; `herdr --skill` als Referenz für Guide/Help nutzen.
- **Mittelfristig:** Neue Herdr-Fähigkeiten (Maschinen, verbesserte Agent-Detection, Client/Server-Split) in Fleet-Orchestrierung einbauen; Eigenbau nur behalten, wo Herdr keine Task-/Proof-Semantik hat.
- **Langfristig:** Receipt/Monitor-Schicht gegen Herdr-Lifecycle-API evaluieren; Datei-basiertes Wakeup bleibt (Herdr hat keine Event-Subscription, siehe Korrekturen).

---

## 1a. Korrekturen vom 08.09.2026 (Code- und CLI-Verifikation)

Drei Punkte der ursprünglichen Analyse waren falsch oder falsch eingestuft. Sie sind hier korrigiert; die folgenden Abschnitte wurden angepasst.

**K1: `herdr notification` ist kein Event-API.** Der Befehl kennt nur
`notification show <title> [--body] [--position] [--sound]`, einen Desktop-Toast,
den der Aufrufer selbst sendet. Es gibt keine Socket-Subscription, die einen Pane
bei Lifecycle-Events weckt. Folgerungen:

- Datei-basiertes Wakeup (`src/run-wake.mjs`, fs.watch auf Receipts) bleibt die
  Wake-Mechanik; der Timer-Reconciliation-Pfad deckt verlorene Events ab.
- `notification show` bleibt als Operator-UX nutzbar (Toast bei Phasenwechsel,
  blocked, run finish), ist aber kein Architektur-Element.
- Der dokumentierte Gap "Hooks wecken Orchestrator nicht" bleibt bestehen.

**K2: `herdr machine` verwaltet SSH-Verbindungsprofile, keine Flotte.** IDs und
Agent-Namen sind pro Server gescoped; CLI-Kommandos aus dem lokalen Pane treffen
immer die lokale Session. Ein Fleet-Inventar über Maschinen existiert in Herdr
nicht. Multi-Host bedeutet: herdr-axi läuft per SSH auf dem Zielhost, Ergebnisse
werden lokal aggregiert.

**K3: Lifecycle No-Replay ist Niedrig/Mittel, nicht Hoch.** Der Monitor
(`engine/herdr-lifecycle-monitor.sh`) nutzt keine Socket-Subscription, sondern
dual `agent wait --until` plus Tick-Loop. Missed Transitions heilen selbst: nach
`HERDR_MONITOR_CHANGE_WAIT_TICKS=600` (60 s) werden die Waiter abgebrochen, der
Loop liest `agent get` neu. Verbleibende Lücke ist der Millisekunden-Spread
zwischen `agent get` und `agent wait`-Registrierung, und nur bei
flip-and-return. Kein P0-Umbau; P3-Refactor kann die Erkennungslatenz senken.

**Entscheidungen (Stand 08.09.2026):**

| Frage | Entscheidung |
|-------|--------------|
| D1 Multi-Host | Option B: Run lebt auf dem jeweiligen Host, herdr-axi per SSH dort, lokaler Aggregator `fleet status`. Kein Run über Maschinen-Grenzen (bricht Receipt-, Lease- und Lock-Modell). |
| D2 dotfiles/herdr | Option B: Deprecated-Header plus Hinweis auf herdr-axi engine, eine Quelle der Wahrheit. |
| D3 Mindest-Herdr | Option B: Runtime-Probe, unter 0.9 fail, ab 0.9 Protokoll-Generation-Warnung. `engines.herdr` allein reicht nicht, npm prüft das nicht gegen ein Binary. |
| D4 Enter-Fallback bei stalled | Option A: Live-Test gegen 0.9, dann Fallback entfernen, `agent_prompt_stalled` fail-closed in Registry-Stage. |

---

## 2. Versions-Baseline

| Komponente | Alt | Neu | Installationspfad |
|------------|-----|-----|-------------------|
| Herdr Binary | 0.8.0 (Homebrew, Aug 2025) | **0.9.0** (Release 2026-09-07) | `~/.local/bin/herdr` |
| Übersprungen | 0.8.2 (nie lokal installiert) | — | — |
| Protokoll | — | **endpoint_protocol_generation: 1** | `herdr server status` |
| Claude-Integration | v8 | **v9** | `ordex/dotfiles/claude/hooks/herdr-agent-state.sh` |
| herdr-axi | 0.2.0 (npm) | **0.2.1** (lokal) | `~/dev/tools/herdr-axi` |

Upstream-Vergleich `v0.8.2…v0.9.0`: ~110 Commits, ~300 Dateien. Vollständige Release Notes: `~/.config/herdr/release-notes.json`, GitHub `v0.9.0`.

---

## 3. Herdr-Änderungen seit der vorherigen Version

### 3.1 CLI — Neu

| Feature | Befehl / Verhalten | Relevanz für herdr-axi |
|---------|-------------------|------------------------|
| SSH-Maschinen | `herdr machine list\|add\|rename\|remove\|enable\|disable` | Fleet über mehrere Hosts; heute nicht abgedeckt |
| Agent-Ressourcen | `herdr --skill`, `herdr.dev/agent-guide.md`, `herdr.dev/llms.txt` | Guide/Help in herdr-axi angleichen |
| Worktree-Trust | `worktree create\|remove --trust-repository` | Recovery/Worker-Start in fremden Worktrees robuster |
| Group-Close | `workspace close --group` | Schließt Parent + Worktree-Kinder explizit |

### 3.2 CLI — Geändert

| Änderung | Detail | herdr-axi betroffen? |
|----------|--------|---------------------|
| `agent prompt` | Sendet Text + Enter zuverlässig; `--wait` verlangt beobachtetes working/blocked | **Ja** — `herdr-receipt.sh`, Worker-Delivery |
| `agent read` | Recent-Reads enthalten Viewport noch ohne Scroll | **Ja** — Checkpoints, Quota-Scrape, `read` |
| `pane report-agent` | Optionen vor Pane-ID; `--option=value` | Gering — nicht direkt genutzt |
| `agent explain --file` | Strukturierte JSON-Fehler | Gering |
| `herdr update` | Client-Upgrade ohne Server-Stop möglich | Ops: Worker-Env `HERDR_BIN` beachten |
| Help-Routing | AI-Hinweise auf externe Docs statt inline | Dokumentation |

### 3.3 CLI — Entfernt (Breaking)

| Entfernt | Ersatz | herdr-axi |
|----------|--------|-----------|
| `--no-session` (Monolith-Modus) | Immer Server/Client; detach mit `Ctrl+b q`, Stop mit `herdr server stop` | Kein direkter Bezug; `HERDR_ENV=1` bleibt Pflicht |

### 3.4 Konfiguration

| Setting | 0.8.0 | 0.9.0 | Migration |
|---------|-------|-------|-----------|
| `terminal.kitty_graphics` | unter `[experimental]`, default `false` | top-level `[terminal]`, default **`true`** | Alias `experimental.kitty_graphics` noch gültig |
| `ui.pane_borders` | boolean | `"auto"` / `"always"` / `"off"` | Booleans noch akzeptiert |
| `theme.custom` | ein Block | separate `.light` / `.dark` Overrides | Nur UI |
| Sidebar | ohne `machine` Token | Default-Rows inkl. **`machine`** | Fleet-UI später |
| Client/Server-Split | implizit | **explizit dokumentiert** | Remote: Client-Theme, Server-Pane-Defaults |

### 3.5 Architektur / Server

1. **Client-seitiges TUI** — Rendering, Themes, Copy-Mode laufen pro Client, nicht auf dem Server.
2. **Unabhängige Multi-Client-Views** — Verschiedene Clients können verschiedene Workspaces/Tabs sehen.
3. **Kompatible Client-Updates** — Client kann aktualisiert werden; fehlende Server-Features deaktivieren nur betroffene Aktionen.
4. **Endpoint-Protokoll Generation 1** — Ältere Server brauchen einmaliges Upgrade (lokal: kompatibel).

### 3.6 Socket-API / Lifecycle

| Änderung | Auswirkung |
|----------|------------|
| `WorkspaceCloseParams.close_group: boolean` | Group-Close explizit |
| `ServerCapabilities.endpoint_protocol_generation` | Versionsverhandlung möglich |
| **Lifecycle-Subscriptions: nur Live-Events, kein Replay** | Clients müssen **vor** Snapshot subscriben |
| `pane read` recent window | Viewport-Output inkludiert |

### 3.7 Agent-Detection (verbessert)

Betrifft indirekt herdr-axi, weil `agent wait`, blocked-Recovery und Monitor auf korrekte Zustände bauen:

- **Claude Code:** Turn/Background-Agent, MCP/Bash-Approval blocked, Cursor-Hook-Isolation (Integration v9).
- **Codex:** blocked-Genauigkeit, Session-Save vor erstem Prompt, Windows-Prompt-Timing.
- **Copilot CLI:** bleibt `working` bei Background-Agents.
- **Oh My Pi:** kein idle-Flicker bei Continuations.
- **OpenCode:** Parent nicht mehr stuck blocked nach Child-Prompts.
- **Neu: Muse** — Detection-Manifest.

Manifeste werden bei laufendem Server nachgeladen (kein Restart nötig).

### 3.8 Remote / SSH (neu in 0.9.0)

- Lokale + gespeicherte SSH-Maschinen in einem Fenster.
- Kombinierte Agent-Liste, machine-scoped Navigation, Auto-Reconnect.
- Getrennte Maschine unterbricht andere nicht.
- SSH-Client-Detach statt Pane-Resize bei Terminal-Verlust.

### 3.9 Workspaces / Worktrees

| Änderung | Breaking? |
|----------|-----------|
| Parent-Close mit offenen Worktree-Kindern erfordert `--group` | **Ja** |
| `--trust-repository` für einmaliges Git-Trust | Nein |
| Background-Worktree-Remove ändert Focus nicht mehr | Verhalten |
| Windows: Worktree-Remove mit laufenden Agent-Panes | Verhalten |

### 3.10 UI / Input / Plattform (Auswahl)

- Maus-Selektion bleibt während Output sichtbar; Copy vor Mouse-Release.
- Kitty Graphics default on; an Client gebunden.
- Prefix-Bindings mit macOS Option / Custom Layouts.
- Windows: OpenSSH, Clipboard, Antigravity, Devin, `install.cmd` Bootstrap.
- WSL: Bild-Paste aus Windows-Clipboard.

### 3.11 Übersprungene 0.8.2-Features (0.8.0 → 0.9.0 Sprung)

Falls relevant für ältere Docs: Qwen-Detection, Tab-Bar-Status, `move_tab_previous/next`, Windows `herdr --remote`, Cursor Agent CLI, MastraCode, Hermes, Grok, Copy-Mode `B`/`E`/`W`, Plugin-Marketplace-Subdirs, Headless 120×40 (statt 80×24), Windows GA.

---

## 4. Lokaler Bash-Stack (nicht upstream)

Parallel zu herdr-axi existiert `ordex/dotfiles/herdr/` — ein älterer, schmalerer Orchestrator-Layer (Sep 2–4, 2026):

```
ordex/dotfiles/herdr/herdr-orchestrator.sh
ordex/dotfiles/herdr/herdr-worker.sh
ordex/dotfiles/herdr/herdr-hook-notify.sh
ordex/dotfiles/herdr/herdr-lifecycle-monitor.sh
ordex/dotfiles/herdr/herdr-monitor-plugins/
```

**Diff zu `herdr-axi/engine/`:** alle Kern-Skripte divergieren; herdr-axi hat zusätzlich `herdr-receipt.sh`, Managed-Run-Modell, Tests (`test-herdr-monitor.sh`).

Dotfiles-Commits seit Import:

| Commit | Inhalt |
|--------|--------|
| `ca46a12` | Initial-Import Orchestrator/Worker/Monitor |
| `d07285f` | Codex ≥0.149: `--approve-for-me` vs `--sandbox` |
| `33ad77e` | Monitor-Input-Events mit neuem Fingerprint |
| `5b004d6` | Fingerprint ohne Hook-Title (Dedup native + Monitor) |

**Fazit:** Zwei Forks desselben Konzepts. herdr-axi ist der vollständige Managed-Run-Pfad; dotfiles-herdr ist Legacy/lightweight.

---

## 5. herdr-axi heute — Architektur und Herdr-Kopplung

### 5.1 Schichten

```
bin/herdr-axi.mjs → src/*.mjs (CLI, Policy, Run-State)
        ↓ spawn
engine/*.sh → herdr CLI → Tabs/Panes/Agents
        ↓
Native CLIs (claude/codex/copilot) in Worker-Panes
```

State: `~/.local/state/herdr-axi/` (Runs, Leases, Archive). Policy: `.herdr-axi.json`.

### 5.2 Herdr-CLI-Aufrufe (vollständig)

**JavaScript (`src/herdr.mjs`):**

- `agent list`, `agent get`, `agent read` (`visible` / `recent` / `recent-unwrapped`)
- `agent wait --until STATE --timeout MS`
- `agent prompt`, `agent send-keys`
- `pane current --current`, `pane get`
- `tab rename`, `tab get`

**Engine (Bash):**

- `tab create` (mit `--env`, `--no-focus`), `tab close`
- `pane split`, `pane run`, `pane wait-output --match`
- `agent start --kind`, `agent prompt --wait`, `agent wait`, `agent read`, `agent get`, `agent send-keys enter`

### 5.3 Eigenbau (nicht an Herdr delegiert)

| Bereich | Implementierung | Überschneidung mit Herdr 0.9 |
|---------|-----------------|------------------------------|
| Run/Task-Queue | `run.json`, Phasen, Caps, 128 Tasks, Deps | Herdr hat keine Task-API |
| Worktree-Leases | `~/.local/state/herdr-axi/writers/` | Herdr hat keine Lease-API |
| Receipt/Proof | `herdr-receipt/3`, Generationen, `.inbox`, Locks | Herdr: idle≠accepted completion |
| Lifecycle-Monitor | 25%-Pane, dual `agent wait`, Hooks | Resilient gegen No-Replay (K3); kein Proof in Herdr |
| Hook-Notify | Transcript-Parsing, Quota-Regex | Cursor-Isolation jetzt in Herdr |
| Watch/Wakeup | `fs.watch` auf Receipt-Dateien | Bleibt: Herdr hat kein Event-Wakeup (K1) |
| Quota | Terminal-Text-Regex | Kein Provider-API |
| Context | Transcript-Dateien + `agent read` | Unverändert |
| TOON/Guide | `axi-sdk-js`, lokale Recipes | `herdr --skill` parallel |

### 5.4 Bekannte brittliche Annahmen

1. Keine Herdr-Versionsverhandlung (Runtime-Probe fehlt komplett, kein `--version`, kein `herdr server status`).
2. `agent read --source recent-unwrapped` — seit 0.9 dokumentiert und empfohlen ("prefer it for logs and transcripts"), brittleness erledigt.
3. `pane wait-output --match` — Monitor-Startup hängt davon ab (10s Timeout).
4. `tab create --env` — viele injizierte Env-Vars.
5. Orchestrator-Identität = **Pane-ID**, nicht Agent-Name.
6. Error-Code-Mapping per Message-Substring.
7. `HERDR_ENV=1` Hard-Gate — kein Standalone-Fleet-Tool.
8. Hooks schreiben Inbox, **wecken Orchestrator nicht** (by design).
9. BSD `stat -f` in Receipt-Locks (macOS).
10. Kein `herdr machine` — nur lokale Session.

---

## 6. Impact-Matrix: Herdr 0.9 → herdr-axi

| Herdr-Änderung | Risiko | Empfohlene Reaktion |
|----------------|--------|---------------------|
| `agent prompt --wait` strenger | Mittel | Live-Tests für Delivery/Retry; stalled-Handling prüfen |
| `agent read` recent inkl. Viewport | Niedrig | Positiv für Checkpoints/Quota; Regression-Test; `recent-unwrapped` ist jetzt dokumentierter Empfehlungspfad |
| Lifecycle kein Replay | **Niedrig/Mittel** (korrigiert K3) | Monitor ist resilient (60 s Re-Snapshot); P3: Latenz senken, keine sofortige Änderung |
| Worktree group close | Mittel | `run close`/Archive: `--group` wenn Parent+Kinder |
| `--no-session` entfernt | Niedrig | Docs: immer Server-Modell |
| Client/Server-Split | Mittel | `HERDR_BIN` in Worker pinnen; Update-Pfad dokumentieren |
| Verbesserte blocked/detection | Niedrig | Weniger false positives in Monitor; ggf. Retry-Pfade vereinfachen |
| Claude Cursor-Hook-Isolation | Niedrig | Hook-Plugins redundant teilweise; Dedup-Logik reviewen |
| `herdr machine` | Chance, aber nur Profile (korrigiert K2) | Neue `fleet machine`-Profile; Kontrolle per SSH auf dem Zielhost, kein Fern-Inventar |
| Multi-Client Views | Chance | Owner/Takeover über Client-Grenzen härten |
| `herdr --skill` | Chance | `guide` mit Herdr-Skill synchron halten |
| Integration v9 | Niedrig | Monitor-Plugins gegen neue Hook-Semantik testen |

---

## 7. Anpassungs- und Verbesserungsplan

### Phase A — Kompatibilität (sofort, v0.2.2)

1. **`engines.herdr` in package.json** — `"herdr": ">=0.9.0"` + README/Operator-Guide. Wichtig: npm prüft `engines` nicht gegen ein Binary; das eigentliche Gate ist die Runtime-Probe (Punkt 6).
2. **Smoke gegen 0.9.0** — `npm test` + gezielter Live-Test-Subset (prompt delivery, monitor startup, blocked recovery).
3. **Lifecycle-Race** — kein Umbau nötig (K3): Monitor heilt verpasste Transitions über den 60 s Re-Snapshot. Nur Dokumentation der Latenz-Eigenschaft.
4. **Group-Close** — `run close`/Worker-Cleanup schließt Tabs einzeln, nie den Parent-Workspace; Normalpfad unberührt. Docs-Warnung gegen manuelles Schließen des Run-Workspaces genügt, kein Code.
5. **Dotfiles-Konsolidierung** — `ordex/dotfiles/herdr` als deprecated markieren oder als Symlink/Thin-Wrapper auf herdr-axi engine; eine Quelle der Wahrheit (Entscheidung D2: deprecated markieren).
6. **Runtime-Versionsprobe** — bei `run init`: `herdr --version` und `herdr server status` lesen, `endpoint_protocol_generation` in run.json schreiben, unter 0.9 fail, bei Mismatch warnen.
7. **Prompt-Flags an 0.9 anpassen** — `herdr-receipt.sh:446`: Defaults nicht mit `--until` wiederholen; stalled-Enter-Fallback nach Live-Test entfernen, `agent_prompt_stalled` fail-closed (Entscheidung D4).

### Phase B — Nutzen von Herdr 0.9 (v0.3.0)

| Feature | Aktion | Ersetzt Eigenbau? |
|---------|--------|-------------------|
| `herdr machine` | Profile verwalten (`fleet machine list/add`); Ausführung je Host per SSH, lokaler Aggregator `fleet status` (D1) | Nein, erweitert Fleet |
| `herdr notification show` | Operator-Toast bei Phasenwechsel/blocked/run finish; **kein** Wakeup-Pfad (K1) | Nein, reine UX |
| Verbesserte `agent wait` | Monitor vereinfachen wo Detection stabil | **Teilweise** Polling-Fallback |
| `worktree --trust-repository` | In `run queue`/`recover` bei Git-Trust-Fehlern | Nein, nutzt Herdr |
| `herdr --skill` diff | `guide`/`--skill` periodisch diffen und TOON-Rezepte aktualisieren | Nein |
| Server-Capabilities | Runtime-Probe bei `run init` (Phase A Punkt 6) | Nein |

### Phase C — Eigenbau ablösen oder behalten

| Eigenbau | Behalten | Ablösen durch Herdr | Begründung |
|----------|----------|---------------------|------------|
| Run/Phase/Task-Queue | **Ja** | — | Kerndifferenzierung; Herdr hat kein Task-Modell |
| Generation-Proof / accept-revise | **Ja** | — | idle/done ≠ reviewed acceptance |
| Worktree-Leases | **Ja** (kurz) | Später evaluieren | Cross-Run Writer-Exclusion |
| 25%-Lifecycle-Monitor-Pane | **Ja** (kurz) | Ggf. Hooks + `agent wait` only | Sichtbarkeit für Operator; nach 0.9 Detection evtl. schlanker |
| Hook-Plugins (claude/copilot) | Prüfen | Wenn Herdr native Events reichen | Integration v9 + Cursor-Isolation reduziert Dedup-Bedarf |
| Quota-Regex | **Ja** (mittel) | Provider-API falls verfügbar | Kein Herdr-Quota-API |
| Transcript-Context-Parsing | **Ja** | — | Herdr liefert kein Token-Budget |
| `fs.watch` Wakeup | **Ja** | Kein Herdr-Event-API (K1); Timer-Reconciliation deckt verlorene Events ab |
| `ordex/dotfiles/herdr` | **Nein** | herdr-axi engine | Duplikat entfernen |
| Receipt-Dateien auf Disk | **Ja** | — | Audit, offline `history`, Generation-Boundaries |

### Phase D — Neue Funktionalität

1. **Multi-Machine Fleet** — Runs leben auf dem jeweiligen Host (D1); herdr-axi wird per SSH dort ausgeführt, lokaler Aggregator `fleet status` fasst Profile und Host-Status zusammen. Kein Run über Maschinen-Grenzen.
2. **Protokoll-Health** — Runtime-Probe bei `run init`: Herdr-Version, `endpoint_protocol_generation`, Integration-Version in run.json (Phase A Punkt 6).
3. **Expliziter Group-Lifecycle** — Docs-Warnung für manuelles Schließen des Run-Workspaces (`workspace close --group` nur nach Review); Normalpfad von `run close` bleibt Tabs-einzeln.
4. **Operator-Toast** — `herdr notification show` bei Phasenwechsel, blocked und run finish (K1: reine UX, kein Wakeup).
5. **Ready-Ack über Datei** — Monitor-Startup-Handshake in `herdr-worker.sh:291` von `pane wait-output --match` auf einen Datei-Marker im Receipt-Dir umstellen; robuster gegen Rendering-Änderungen (Kitty Graphics default on).
6. **Guide-Sync** — Script/CI: `herdr --skill` vs `herdr-axi --skill` Drift-Warnung.
7. **Linux-Portabilität** — Receipt-Locks: `stat` portable machen (heute BSD-biased).

---

## 8. Konkrete Code-Stellen für Phase A

| Datei | Prüfpunkt |
|-------|-----------|
| `src/herdr.mjs` | Version probe; `mapErrorCode` für neue 0.9 Codes |
| `engine/herdr-receipt.sh` | `agent prompt --wait`: `--until`-Default-Duplikate entfernen; stalled-Enter-Fallback (Zeilen 469 bis 486) nach Live-Test entfernen, fail-closed |
| `engine/herdr-lifecycle-monitor.sh` | Kein Umbau nötig (K3); P3: Erkennungslatenz über 60 s Tick-Cap senken |
| `engine/herdr-worker.sh` | Ready-Ack (Zeile 291): `pane wait-output --match` durch Datei-Marker ersetzen |
| `engine/herdr-hook-notify.sh` | Dedup mit native Herdr-Hooks (Cursor) |
| `src/runs.mjs` | Checkpoints via `recent-unwrapped`; Version/Generation in run.json bei `run init` |
| `docs/operator-guide.md` | Herdr ≥0.9, kein `--no-session`, Server-Modell, Workspace-Close-Warnung |
| `ordex/dotfiles/*/skills/crab/SKILL.md` | Stale "herdr 0.8.0" Referenz |

---

## 9. Empfohlene Prioritäten

| Prio | Item | Aufwand | Nutzen |
|------|------|---------|--------|
| P0 | Live-Smoke 0.9 + D4-Entscheid (stalled-Fallback) | 1 Tag | Stabilität, korrekte Delivery |
| P0 | Runtime-Versionsprobe (run init) + engines + Docs | 0.5 bis 1 Tag | Fail-fast, Protokoll-Health |
| P0.5 | Prompt-Flags (`--until`-Duplikate) aufräumen | 0.5 Tag | Korrekte 0.9-Semantik |
| P0.5 | Dotfiles/herdr deprecated markieren | 0.5 Tag | Wartbarkeit |
| P1 | Group-Close Docs-Warnung | 1 h | Korrektes Cleanup |
| P1 | Ready-Ack über Datei statt Output-Match | 1 Tag | Robuster kritischer Pfad |
| P2 | `herdr machine` Profile + SSH-Host-Ausführung (D1) | 2 bis 3 Tage | Neues Feature |
| P2 | Operator-Toast (`notification show`) | 0.5 Tag | UX |
| P3 | Monitor-Latenz senken nach Detection-Gewinn | 2 bis 4 Tage | Weniger Shell-Komplexität |
| P3 | Guide/Skill-Sync, stat-Portabilität | laufend | Agent-Ergonomie, Portabilität |

---

## 10. Offene Fragen

Entscheidet (Stand 08.09.2026, siehe Abschnitt 1a): D1 (Multi-Host, Option B),
D2 (dotfiles deprecated), D3 (Runtime-Probe, unter 0.9 fail), D4 (stalled-Fallback
nach Live-Test entfernen). Verbleibend:

1. Operator-Toast: welche Events verdienen einen Toast (Phasenwechsel, blocked, run finish)?
2. SSH-Host-Ausführung: direkter `ssh <host> herdr-axi ...` oder Agent-Relay über einen SSH-Pane pro Host?
3. Monitor-Latenz: ist die 60-s-Heilung akzeptabel oder braucht es ein schmales `agent get` im Tick-Pfad?

---

## Anhang: Herdr-CLI-Referenz (0.9.0, relevant für herdr-axi)

```bash
herdr --version                    # 0.9.0
herdr server status                # endpoint_protocol_generation
herdr agent list|get|read|wait|prompt|start|send-keys
herdr pane current|get|split|run|wait-output
herdr tab create|close|rename|get
herdr workspace close --group      # NEU: explizit
herdr worktree create --trust-repository
herdr machine list|add|...         # NEU
herdr --skill                      # aktualisierte Agent-Anleitung
```

Quellen: `~/.config/herdr/release-notes.json`, `herdr --skill`, Live-Inspektion 2026-09-08, herdr-axi Quellcode unter `src/` und `engine/`.
