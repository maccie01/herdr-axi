# Spike: eigene Provider-Hooks gegen Herdr-Signale

Frage: Kann herdr-axi die eigenen Monitor-Plugins (Claude, Copilot) und den
Codex-`notify`-Hook streichen und sich allein auf Herdr-Integration, Event-Wait
und Generationsnachweis stützen, ohne Signale oder Aussagekraft zu verlieren?

## Schalter

| Variable | Wirkung |
|---|---|
| `HERDR_AXI_NATIVE_HOOKS=0` | startet Worker ohne `--plugin-dir` und ohne Codex-`notify` |
| `HERDR_AXI_SIGNAL_TRACE=/pfad/trace.tsv` | protokolliert je Signal: Zeit, Quelle (`native-hook`, `event-wait`, `render`), Agent, Ereignis, Ergebnis, Grund |

Beide sind standardmäßig aus; ohne sie verhält sich die Engine wie auf `main`.

## Matrix

Je Provider (claude, copilot, codex) und Variante (Hooks 1, Hooks 0):

1. **Abschluss**: kleine Schreibaufgabe mit Abschlussbericht.
2. **Rückfrage**: Aufgabe, die vor dem Weiterarbeiten eine Rückfrage an den Nutzer stellen muss (Claude AskUserQuestion, Copilot ask_user). Codex hat keinen Input-Hook, dort nur Event-Wait.
3. **Fehler oder Kontingent**: nicht deterministisch auslösbar; nur mitschreiben, wenn es auftritt.

Zwölf Worker für 1 und 2. Aufträge klein halten.

## Ablauf

```sh
export HERDR_AXI_SIGNAL_TRACE="$PWD/trace-hooks1.tsv" HERDR_AXI_NATIVE_HOOKS=1
herdr-axi run init   # danach Export und queue --start wie von init ausgegeben
# ... Szenarien je Provider, auf Inbox warten, Worker schließen ...
export HERDR_AXI_SIGNAL_TRACE="$PWD/trace-hooks0.tsv" HERDR_AXI_NATIVE_HOOKS=0
# ... dieselben Szenarien ...
```

## Auswertung

```sh
# erstes zugestelltes Signal je Agent und Ereignis, mit Quelle
awk -F'\t' '$5=="delivered" && !seen[$3 FS $4]++ {print $3, $4, $2, $1}' trace-hooks1.tsv
# Zeitvorsprung der nativen Hooks: received native-hook gegen received event-wait
awk -F'\t' '$5=="received" && !seen[$3 FS $4 FS $2]++ {t[$3 FS $4 FS $2]=$1}
  END {for (k in t) if (k ~ /native-hook$/) {e=k; sub(/native-hook$/,"event-wait",e); if (e in t) printf "%s %.1fs\n", k, t[e]-t[k]}}' trace-hooks1.tsv
```

Vergleich Hooks 1 gegen 0: Kommt jedes Ereignis an? Wie groß ist der Zeitabstand?
Stehen im Inbox-Eintrag (`<receipt>.inbox`, Feld `detail`) dieselben Informationen,
etwa Abbruchgrund oder Dialogtext?

## Entscheidungsregel

Streichen, wenn mit Hooks 0 alle Ereignisse aus 1 und 2 ankommen, der Abschluss
höchstens einen Event-Wait-Zyklus später gemeldet wird und Rückfragen im Inbox-Eintrag
erkennbar bleiben. Sonst behalten und den fehlenden Signaltyp dokumentieren.
