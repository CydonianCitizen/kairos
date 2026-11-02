import React from 'react';
import { render } from 'ink-testing-library';
import { it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { App } from '../src/ui/App.js';
import { UiController } from '../src/ui/controller.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const text = `Nessuna modifica fatta — solo consigli. Dal tuo diario emergono tre filoni chiari: JRPG narrativi e misteri (Persona,
Phoenix Wright, Layton), Pokémon classici in stile BW/HGSS e action/avventura (Zelda, MGS, Souls). Ecco cosa gira bene
su DS/3DS:

## Se vuoi altri mystery / visual novel
• Ghost Trick: Phantom Detective (DS) — stesso autore di Phoenix Wright, geniale e sottovalutato.
• Ace Attorney Investigations 1 & 2 (DS) — spin-off con Edgeworth, se ti è piaciuta la trilogia originale.
• Apollo Justice: Ace Attorney (DS) — quarto capitolo principale.
• Zero Escape: 999 (DS), poi Virtue's Last Reward e Zero Time Dilemma (3DS) — puzzle narrativi con escape room e trame
folli, perfetti se ami Layton ma vuoi più storia.

## Se vuoi altri JRPG "Persona-like"
• Shin Megami Tensei IV e IV: Apocalypse (3DS) — la serie madre di Persona, più cruda e dark.
• Persona Q / Persona Q2 (3DS) — crossover Persona + Etrian Odyssey, molto fanservice ma solido.
• Devil Survivor Overclocked (DS) e Devil Survivor 2 (3DS) — tattici con turni e scelte morali.
• Radiant Historia (DS) — storia politica ben scritta, sistema di combattimento originale.

## Pokémon (visto che BW2 e HGSS ti sono piaciuti tantissimo)
• Pokémon Mystery Dungeon: Esploratori del Tempo/Oscurità/Cielo (DS) — spin-off roguelike surprisingly profondo.
• Pokémon Conquest (DS) — tattico storico, insolito ma ben fatto.

## Classici DS/3DS da non perdere
• Chrono Trigger (DS) — porting perfetto di un capolavoro.
• The World Ends With You (DS) — Tokyo, stile, colonna sonora.
• Dragon Quest IV, V, VI, IX (DS) — i migliori della serie in portatili.
• Mario & Luigi: Bowser's Inside Story (DS) e Dream Team (3DS).
• Fire Emblem Awakening (3DS) — il gioco che ha rilanciato la serie.
• Bravely Default (3DS) — JRPG old-school con sistema di combattimento "Bravely/ Default" addictive.

## Zelda su queste piattaforme
• The Legend of Zelda: Ocarina of Time 3D e Majora's Mask 3D (3DS) — remake excellenti.
• Phantom Hourglass e Spirit Tracks (DS) — avventure solide con controlli touch.
• A Link to the Past (se non l'hai fatto su GBA/Switch Online).

## Extra rapidi
• Metroid: Samus Returns (3DS) — remake di Metroid II, ottimo.
• Castlevania: Dawn of Sorrow / Order of Ecclesia (DS).
• Professor Layton: Il diabolico scrigno (Pandora's Box), Il futuro perduto e L'ultima spectre (DS) — se ti è piaciuto
Curious Village, questi sono i migliori della serie.

Se vuoi, posso restringere la lista a un solo genere o dirti quali sono i "must assoluti" in base al voto più alto che
dai (tipo BW2 a 100% e Fallout 3 a 100% → punterei su JRPG narrativi come SMT IV o Zero Escape).`;

it('does not leave a void of blank lines after a completed streaming response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kairos-test-blank-'));
  const client = new class extends EventEmitter {
    async stream() {
      this.emit('onTokenStream', text);
      return {
        ok: true as const,
        value: [{ id: '1', choices: [{ delta: { content: text }, finish_reason: 'stop' as const }] }]
      };
    }
  }();

  const agent = new AgentLoop({ workspace: root, client, session: false });
  const controller = new UiController(agent);

  try {
    await controller.start();
    const app = render(<App controller={controller} version="0.0.1-alpha" />);
    await new Promise(r => setTimeout(r, 100));

    await controller.submit('consigliami giochi ds');
    await new Promise(r => setTimeout(r, 500));

    const frame = app.lastFrame()!;
    const lines = frame.split('\n');

    // Find the line where the response ends
    const responseEndIndex = lines.findLastIndex(l => l.includes('Zero Escape'));
    expect(responseEndIndex).toBeGreaterThan(0);

    // Find where the input box prompt starts
    const inputPromptIndex = lines.findIndex(l => l.includes('Ask a question'));
    expect(inputPromptIndex).toBeGreaterThan(responseEndIndex);

    const gapLines = inputPromptIndex - responseEndIndex;
    
    // There should only be normal entry spacing (marginBottom) and dock border, NOT an ocean of 18+ blank lines!
    expect(gapLines).toBeLessThanOrEqual(7);

    // Now test TURN 2: follow-up turn
    await controller.submit('altro suggerimento');
    await new Promise(r => setTimeout(r, 500));

    const frame2 = app.lastFrame()!;
    const lines2 = frame2.split('\n');
    const responseEndIndex2 = lines2.findLastIndex(l => l.includes('Zero Escape'));
    const inputPromptIndex2 = lines2.findIndex(l => l.includes('Ask a question'));
    const gapLines2 = inputPromptIndex2 - responseEndIndex2;
    expect(gapLines2).toBeLessThanOrEqual(7);

    app.unmount();
  } finally {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
