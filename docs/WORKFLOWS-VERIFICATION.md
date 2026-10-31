# Verifica delle funzionalità agente — 31 ottobre 2026

## Implementato

- Sessioni JSONL con checkpoint, ripresa/lista/nuova sessione, lock concorrenti e recupero della coda interrotta.
- Compattazione semantica NIM e fallback locale, con riassunti interni esclusi dallo streaming visibile.
- Modalità plan applicata dal dispatcher: niente edit, shell, plugin o MCP.
- MCP stdio e Streamable HTTP tramite SDK ufficiale; discovery, tool batch e risorse, timeout/cancellazione.
- AGENTS.md autorizzato, skill locali, plugin ESM con tool, comandi, hook e cleanup.
- Follow-up FIFO e steering a confini sicuri, TUI inline, JSONL, RPC e API SDK con exports/types.

Guida operativa: [WORKFLOWS.md](WORKFLOWS.md). Piano e decisioni: [agent-workflows](superpowers/plans/2026-10-31-agent-workflows.md).

## Revisione indipendente

Un revisore separato ha esaminato le integrazioni in sola lettura. Tre difetti riprodotti e corretti con regressioni osservate prima fallire e poi passare:

1. Il ripristino di una sessione build sovrascriveva `setMode('plan')` chiamato prima dell'inizializzazione. Ora le selezioni esplicite iniziali di modello/modalità prevalgono e vengono salvate.
2. `await interaction.prompt()` terminava prima del rilascio dello stato busy. Ora l'operazione successiva vede il turno effettivamente terminato; i follow-up già in coda conservano la precedenza.
3. Un errore di caricamento delle estensioni lasciava una Promise rifiutata in cache. Ora registrazioni parziali vengono rimosse e il tentativo successivo riparte.

Sono inoltre coperti blocco dei cambi di sessione concorrenti, cancellazione della compattazione senza perdita della cronologia, persistenza disabilitata, hook di fine turno su errore del provider e input della TUI durante il lavoro. Il recupero dei lock usa un guard separato per impedire che due recuperatori rimuovano reciprocamente il nuovo lock; un guard `.recover` lasciato da un arresto durante il recupero richiede ispezione manuale.

## Verifiche

- Typecheck TypeScript strict con controlli sui simboli inutilizzati.
- Build di produzione e importazione SDK dal package senza avviare la CLI.
- Suite completa: 71 test in 14 file.
- MCP con processi stdio reali e server HTTP locale, autenticazione tramite riferimenti a variabili e cancellazione.
- CLI `--help`, output `--json` con trasporto NIM simulato, RPC reale su stdin/stdout e uscita RPC con codice 130 su SIGTERM.
- npm audit: zero vulnerabilità note.

Nessuna chiamata NIM reale e nessun servizio MCP remoto sono stati utilizzati. Il trasporto NIM simulato degli smoke test intercetta solo l'endpoint NVIDIA, lasciando al runtime il caricamento WASM. I test di piattaforma sono stati eseguiti su Windows; Linux e macOS non sono stati provati in questa sessione.

## Limiti espliciti

I journal non sono cifrati, possono contenere sorgente sensibile e non garantiscono durabilità a un'interruzione elettrica. Plan mode non è una sandbox OS. Plugin e server configurati sono codice/servizi fidati: un plugin deve cooperare con AbortSignal, non scrivere direttamente su stdout nei modi macchina e liberare le proprie risorse. Non ci sono marketplace, installazioni automatiche di plugin, login OAuth MCP interattivo, elicitation, UI web o estensioni specifiche per editor. La compatibilità con plugin Pi/OpenCode non è promessa. Le scelte sono documentate nella guida.

Il ramo di lavoro è `codex/sessions-extensions`. Il repository conteneva file non ancora tracciati prima del lavoro; non sono stati creati commit, reset o cancellazioni del lavoro esistente.
