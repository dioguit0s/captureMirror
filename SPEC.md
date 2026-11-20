# Capture Mirror — SPEC

App desktop para Windows que espelha vídeo e áudio de uma placa de captura USB (UVC) numa janela, para ser compartilhada no Discord (Go Live) como se fosse um jogo, com o áudio junto.

**Status:** fases 1, 2 e 3 implementadas, com o design do protótipo aplicado, e testadas com dispositivo simulado, webcam e placa real. Na placa, som e desconexão USB foram aprovados na versão portátil. O instalador NSIS foi executado e o app instalado abre e mostra o vídeo da placa. Falta testar o Go Live.

A **fase 4 (clipes e coleção)** foi implementada e testada com a placa real, mas sem a call do Discord. Os detalhes estão em "Fase 4" e "Clipes: medições".

A **fase 6 (Tauri e áudio nativo)** trocou o Electron pelo Tauri 2 com WebView2 e passou o som da placa para um motor WASAPI em Rust. O atraso do som caiu de ~125 ms para ~65 ms, e o app ficou bem menor. Os detalhes estão em "Fase 6". As fases anteriores descrevem decisões tomadas no Electron. As que mudaram estão marcadas lá.

## Arquitetura

```
Placa USB ──> getUserMedia (vídeo, WebView2) ──> <video muted> ──> janela "Capture Mirror" ──> Discord
         └──> WASAPI (Rust) ──> fila mínima ──> volume/mute ──> saída padrão em modo raw ──> Discord

Clipes:
vídeo (clone) ─> MediaStreamTrackProcessor ─> VideoEncoder H.264 ─┐
loopback WASAPI (Rust) ─> AudioWorklet ─┬─> AudioContext (sem saída) ─> AudioEncoder ┴─> buffer na RAM (~62 s)
microfone opc. (getUserMedia) ──────────┘                                                │ atalho ou botão
                                           mediabunny (MP4) <────────────────────────────┘ ─> Rust grava em Vídeos\Capture Mirror

Modo navegador, para o Google Meet (só com uma guia conectada):
vídeo (mesma faixa) ───────────────────────────────────┐
placa (getUserMedia) ─> Gain ─> MediaStreamDestination ┴─> RTCPeerConnection ══ WebRTC local ══> guia (src/player) ─> Meet
            oferta e resposta: renderer ⇄ IPC ⇄ Rust (HTTP + SSE em 127.0.0.1:47830) ⇄ página
```

- **Rust (`src-tauri`):** janelas, permissões de mídia, flags do WebView2, configuração, motor de áudio e loopback, clipes (gravação, lista, Lixeira, protocolo `clip`), atalhos globais, aviso do Windows e o servidor do modo navegador.
- **Ponte (`src/renderer/api.js`):** `window.captureMirror`, com a mesma forma do antigo preload do Electron, sobre `invoke` e eventos do Tauri.
- **Renderer (WebView2):** vídeo, overlay, codificação dos clipes e WebRTC do modo navegador.

## Estrutura de pastas

```
captureMirror/
├─ package.json
├─ scripts/vendor.js         # copia o mediabunny para src/renderer/vendor
├─ src-tauri/                # lado nativo (Rust): tauri.conf.json, capabilities, ícones
│  └─ src/
│     ├─ main.rs             # janelas, permissões, protocolo clip, registro dos comandos
│     ├─ settings.rs         # JSON na pasta de dados, com migração do Electron
│     ├─ window.rs           # posição e tamanho, tela cheia
│     ├─ audio/              # motor WASAPI (engine.rs), loopback, dispositivos
│     ├─ clips.rs            # pasta, lista, gravação, Lixeira, protocolo, arrastar, aviso
│     ├─ shortcuts.rs        # atalhos globais dos clipes
│     └─ share.rs            # servidor do modo navegador (HTTP + SSE)
├─ tools/medir-latencia/     # passthrough.cpp e pulse.cpp: medem o atraso do som
├─ README.md
├─ SPEC.md
├─ TELAS.md                  # briefing de telas e ícone para o protótipo
├─ Main.dc.html, Icone.dc.html  # cópias do protótipo, só para referência
├─ design/                   # tokens e ícone originais
├─ build/icon.png            # fonte dos ícones de src-tauri/icons
└─ src/                      # servido pelo Tauri como está (frontendDist)
   ├─ renderer/
   │  ├─ index.html
   │  ├─ style.css
   │  ├─ api.js              # ponte window.captureMirror sobre o Tauri
   │  ├─ app.js              # orquestra tudo
   │  ├─ capture.js          # getUserMedia, fallback, capacidades, permissão do WebView2
   │  ├─ audio.js            # som da placa pelo motor nativo; caminho do modo navegador
   │  ├─ loopback-worklet.js # toca no contexto dos clipes o som do PC vindo do Rust
   │  ├─ vendor/             # mediabunny (gerado pelo npm run vendor, fora do git)
   │  ├─ overlay.js          # overlay, cursor e painel de informações
   │  ├─ select.js           # seletor de dispositivo do protótipo
   │  ├─ replay.js           # buffer de replay: encoders, pacotes na RAM, MP4 (fase 4)
   │  ├─ clipaudio.js        # som do PC (do Rust) + microfone opcional para os clipes
   │  ├─ share.js            # emissor WebRTC do modo navegador (fase 5)
   │  └─ clips.html/.js/.css # janela da coleção (fase 4)
   └─ player/                # página aberta no navegador pelo modo navegador (fase 5)
```

## Decisões técnicas

| Tema | Decisão | Motivo |
|---|---|---|
| Linguagem | JavaScript puro com módulos ES no renderer | Sem etapa de build. O projeto é pequeno |
| Dependências | `@tauri-apps/cli` para desenvolvimento (desde a fase 6; antes, `electron` e `electron-builder`). Na fase 4, `mediabunny` (MPL-2.0, sem dependências) em produção, copiado para `src/renderer/vendor` pelo `npm run vendor` | Gerar MP4 à mão daria mais código para manter e mais risco de arquivo incompatível |
| Segurança | `contextIsolation` e `sandbox` ligados, `nodeIntegration` desligado, CSP restrita, só as permissões `media` e `display-capture` liberadas | Não há conteúdo remoto, mas o custo é zero. `display-capture` é para o loopback dos clipes |
| Dispositivo | `deviceId: { exact }` | Com `ideal`, o Chromium poderia trocar a placa pela webcam sem avisar |
| Vídeo | Resolução escolhida no overlay (480p, 720p, 1080p e, se `getCapabilities()` permitir, 1440p e 2160p) como `ideal`, a 60 fps. Padrão 720p, salvo em `resolution`. Trocar reabre a placa. Se a abertura falhar, tenta de novo só com o `deviceId` | Em 1080p a placa testada mostra só 30 FPS, então o padrão é 720p. Placas melhores podem usar 1080p60. Testado com a MS2109 pelo seletor: 1080p a 30 FPS |
| Áudio | **Desde a fase 6:** WASAPI em Rust, com a captura convertida pelo Windows para o formato da saída. Antes: `getUserMedia` com processamentos desligados | Ver "Fase 6" |
| Volume e mute | **Desde a fase 6:** ganho aplicado no motor nativo, em rampa por pacote. Antes: `MediaStreamSource → GainNode → destination` | O Discord captura a saída do processo, então volume e mute continuam valendo para o stream |
| Salvar dispositivos | Guarda `deviceId` **e** `label`. Restaura pelo id e, se falhar, pelo label | O `deviceId` do Chromium pode mudar. O label é mais estável |
| Janela | Moldura nativa, sem menu, área de conteúdo inicial de 1280x720, mínima de 640x360, título travado via `page-title-updated` | Comportamento de um jogo em janela comum |
| Atalho M | Mostra o overlay por 2 s ao alternar o mute | Confirma visualmente o estado, já que mute silencia também o stream |
| Mute | Não é salvo: o app sempre abre com som | Abrir silenciado sem aviso deixaria o stream mudo |
| Posição da janela | Ao restaurar, é alinhada à grade de pixels físicos | Com escala fracionária, o Chromium aumenta a janela se a posição cair entre pixels, e ela cresceria a cada abertura |
| Reconexão | `sync()` compara o dispositivo escolhido com o aberto, a cada `devicechange` e a cada 1,5 s enquanto falta algo | O `devicechange` pode disparar antes de a placa estar pronta |
| Dispositivo em uso | Só mostra o erro após 3 tentativas falhas. Depois, espera "Tentar novamente" ou um `devicechange` | Logo após reconectar, a placa pode recusar a abertura por alguns instantes |
| Overlay em "Sem sinal" e em erro | Continua disponível | Permite escolher outro dispositivo se a placa salva não voltar |
| Seletores | Componente próprio (`select.js`), como no protótipo, e não `<select>` nativo | O Chromium não avisa quando a lista nativa abre ou fecha. Com o próprio, o overlay fica visível enquanto a lista está aberta |
| Ícone | `build/icon.png`, cópia de `design/icone/capture-mirror.png`. O `tauri icon` gera os ícones de `src-tauri/icons` | Mantém uma única fonte para o ícone |

### Janela desfocada ou coberta

`backgroundThrottling: false` não basta. No Windows, o Chromium detecta quando a janela está totalmente coberta e para de renderizar. Por isso o main também define:

- `disable-features=CalculateNativeWinOcclusion`
- `disable-renderer-backgrounding`
- `disable-background-timer-throttling`
- `disable-backgrounding-occluded-windows`

Janela **minimizada** continua fora do escopo, pois o Discord também não captura bem esse caso.

### MJPEG, YUY2 e capacidades do hardware

O `getUserMedia` **não permite escolher o formato de pixel**: o Chromium decide com base na resolução e no FPS pedidos. Portanto:

- O app não força formato nenhum.
- Ao abrir um dispositivo, o app registra no log `getCapabilities()` e `getSettings()`. O F1 mostra os valores reais.
- Se o formato escolhido causar problema, a investigação usa o `chrome://media-internals`. Não há nada a configurar pelo código.

O app usa o DirectShow em vez do Media Foundation, porque foi o driver com melhor resultado na placa testada (ver "Placa testada"). O formato de pixel continua sem aparecer para o JS.

## Fase 4 — Clipes e coleção

| Tema | Decisão | Motivo |
|---|---|---|
| Linguagem | Continua Electron, com WebCodecs | O encoder de vídeo é o mesmo do Chromium. Reescrever jogaria fora o que já foi validado com a placa |
| Buffer | Pacotes já codificados na RAM, 62 s, um quadro-chave por segundo. O clipe começa no quadro-chave mais próximo de "agora − N s" | Clipar é instantâneo e nada vai para o disco sem pedido. O clipe pode ter até 1 s a mais que o pedido |
| Vídeo | H.264 High, 8 Mbps em 720p60, `latencyMode: realtime`. Tenta `prefer-hardware` e cai para software (o caso deste PC, por causa do sandbox da GPU, que fica ligado). Se não houver H.264, usa VP9 | MP4 com H.264 toca em qualquer lugar, inclusive no Discord |
| Áudio | AAC 160 kbps, 48 kHz, estéreo (Opus se não houver AAC) | Mesmo motivo |
| Som do PC | **Até a fase 5:** loopback via `getDisplayMedia` + `setDisplayMediaRequestHandler`. **Desde a fase 6:** loopback WASAPI no Rust (ver "Fase 6") | É a única forma de pegar o som do sistema no Chromium. O som da placa entra porque o app o toca, sem duplicar. Volume e mute do app valem para o clipe. Não precisou de gesto do usuário |
| Microfone | Opcional, misturado num `AudioContext` que não toca nada, com o processamento de voz ligado. Só fica aberto com a imagem no ar | Não pode sair nos alto-falantes nem no stream |
| Sincronia | Cada faixa é levada ao relógio de `performance.now()` pela chegada do primeiro quadro | O Chromium não garante a mesma origem nos timestamps de vídeo e áudio |
| Disparo | Atalhos globais Ctrl+Shift+F9 (30 s) e Ctrl+Shift+F10 (1 min), mais botões no overlay. Atalho ocupado vira aviso no overlay | Funciona com o Discord ou o jogo em foco |
| Aviso de clipe salvo | Notificação do Windows. Clicar abre a coleção | Um aviso dentro da janela iria para o stream |
| Coleção | Janela separada, com título próprio. Arquivos servidos por `clip://`, que só aceita `.mp4` direto na pasta e implementa Range (206). Excluir manda para a Lixeira | O Go Live mostra só a janela principal. Sem Range, o player não consegue avançar no vídeo |
| Arquivos | `Vídeos\Capture Mirror\Clipe AAAA-MM-DD HH-MM-SS.mp4`. A miniatura (quadro da tela no momento do clipe) e a duração ficam em `.thumbs\` | O MP4 é gravado com outro nome e renomeado, então a coleção nunca lista um clipe pela metade |

### Clipes: medições

Feitas com a placa MS2109 em 720p60 (Intel Iris Xe, 12 núcleos lógicos):

- **Arquivos válidos:** H.264 High 1280x720 a ~59,6 FPS, AAC estéreo 48 kHz. Os clipes de 30 s duraram de 29,5 a 31 s e o de 1 min, 60,8 s. Um som tocado no PC apareceu no clipe junto com o som da placa.
- **Atalho global** testado com outra janela em foco. **Seek** no player da coleção, **Lixeira** e build empacotado (`--dir`) também funcionaram.
- **CPU: ~9% do total com o buffer ligado** (o renderer usa ~0,7 núcleo), contra ~2,5% sem ele. A tela se manteve em 58,7 FPS. O heap JS ficou em ~45 MB com o buffer cheio.
- **Encoder de hardware indisponível:** o `chrome://gpu` lista "Encoding" vazio, e o `isConfigSupported` com `prefer-hardware` retorna `false` para todos os codecs, apesar de o driver da Intel registrar o "Quick Sync Video H.264 Encoder MFT". Com `--disable-gpu-sandbox`, o H.264 de hardware aparece. Ou seja, o sandbox da GPU impede o encoder do driver de carregar. **Decisão (06/11/2026): manter o sandbox da GPU ligado e o encoder por software.** A medição abaixo mostrou ganho de CPU pequeno, que não justifica tirar uma proteção do app inteiro. O código continua tentando `prefer-hardware` primeiro, então outro PC em que o encoder de hardware funcione dentro do sandbox vai usá-lo sozinho. Se a qualidade em cenas rápidas incomodar, o caminho é uma opção "Usar encoder de hardware", desligada por padrão e com retorno automático para o software.
- **Software x hardware, medido** (20 s de CPU com o buffer cheio; o hardware rodou com `--disable-gpu-sandbox` só na linha de comando). Cada rodada pegou uma cena diferente do console:

  | Rodada | Cena | CPU total | Renderer | Processo da GPU (CPU / RAM) | FPS na tela | Taxa do clipe |
  |---|---|---|---|---|---|---|
  | Software 1 | Menu parado | 6,5% | 40% de um núcleo | 17% / 139 MB | 58,0 | 4,3 Mbps |
  | Hardware 1 | Menu parado | 6,2% | 15% | 37% / 300 MB | 57,6 | 3,9 Mbps |
  | Software 2 | Jogo em movimento | 8,2% | 60% | 15% / 135 MB | 56,6 | 5,2 Mbps |
  | Hardware 2 | Menu animado | 6,7% | 17% | 37% / 300 MB | 57,6 | 8,2 Mbps |

  **Conclusão:** o hardware economiza pouco, de 0 a ~1,5 ponto percentual da CPU total. O trabalho sai do renderer, mas o processo da GPU passa a gastar mais CPU (cópia e conversão de cada quadro para a GPU) e ~160 MB a mais de RAM. A vantagem mais clara é a taxa: o hardware chega aos 8 Mbps pedidos em cenas com movimento, enquanto o software fica abaixo disso, o que sugere melhor qualidade em cenas rápidas.

### Riscos em aberto dos clipes

1. **Sincronia de áudio e vídeo** não foi medida (teste da palma).
2. **Call do Discord** no clipe não foi testada com uma call real. O caminho é o mesmo do som de teste, que funcionou.
3. **Arrastar para o Discord** e a **notificação** não foram verificados visualmente.
4. Durante os testes, a placa caiu e voltou duas vezes logo depois de uma instância do app ser encerrada à força. Isso não se repetiu em 60 s parado, ao trocar o microfone nem ao usar o player. A causa provável é o driver ainda soltando a placa, mas não foi confirmada.

## Riscos a validar quando houver placa e Go Live

Só dá para confirmar estes pontos com a placa e o Discord reais, e esse teste não pode ser feito agora. O desenvolvimento segue com as webcams disponíveis, e estes riscos ficam **em aberto até o teste real**. Se algum deles se confirmar, a correção pode exigir ajustes no que já estiver pronto.

1. **Áudio no Discord:** o Chromium toca o som num processo filho (audio service). O Discord deve capturá-lo junto com o processo da janela, como acontece com navegadores. Se não capturar, a alternativa é testar `disable-features=AudioServiceOutOfProcess`.
2. **Tela preta no Discord:** a captura de janelas com aceleração por hardware pode falhar. As alternativas, nesta ordem, são alternar a opção de captura do próprio Discord e desligar os overlays de vídeo do DirectComposition.
3. **Atraso acumulado:** os relógios da placa e da saída de áudio são diferentes, e isso pode acumular atraso ou causar estalos em sessões longas. O teste é uma sessão de 1 hora ou mais. Só adicionamos correção se o problema aparecer.
4. **60 FPS reais:** medido com a placa (ver "Placa testada"). Resolvido no app com 720p a 60 FPS. Falta confirmar como chega no Go Live.

## Placa testada

"USB Video (534d:2109)" e "Interface de áudio digital (USB Digital Audio) (534d:2109)". O ID indica um chip MacroSilicon MS2109, não confirmado de outra forma.

| Modo pedido | Driver | Fonte (FPS) | Na tela (FPS) |
|---|---|---|---|
| 1920x1080 a 60 | Media Foundation | 30 (uma abertura falhou com `AbortError`) | 30 |
| 1920x1080 a 60 | DirectShow | 60 | 30 |
| 1280x720 a 60 | Media Foundation | 60 | 54 |
| 1280x720 a 60 | DirectShow | 60 | 57 a 58 (no app, em 3 aberturas de 15 s, 60 entregues e 0 descartados) |

- **O `getSettings()` não é confiável nesta placa:** ele informa 60 FPS mesmo com 30 na tela. O valor real é o do F1.
- **Causa do limite em 1080p:** a fonte conta 60 FPS, mas só metade é entregue, sem contar como descarte. Não foi determinado se é a placa ou o Chromium, nem qual modo a fonte HDMI estava enviando.
- **Áudio:** a placa se apresenta como **mono a 96 kHz** e não aceita 2 canais nem 48 kHz. O app reamostra para 48 kHz, e o sinal chega igual ao medido direto da placa. As amostras indicam **estéreo a 48 kHz intercalado**, um defeito conhecido desse chip: em 12 janelas de 1 s, cada amostra se pareceu mais com a de 2 posições atrás (0,97 a 0,99) do que com a vizinha (0,81 a 0,93). Isso não foi confirmado com um áudio que alterne esquerda e direita. Se for isso, o som atual é uma mistura em mono dos dois canais. **Decisão:** o som em mono foi aprovado na escuta, então o app não separa os canais.
- **Com DirectShow:** 2,5% de CPU em 12 núcleos lógicos, FPS mantido com a janela coberta e erro de placa em uso funcionando.

## Limitações conhecidas

- **Volume e mute do app afetam o que vai para o Discord**, porque o Discord captura a saída do processo. Mute no app significa stream sem som. Um único volume é suficiente para este projeto.
- **Quem assiste vê tudo o que está na janela,** incluindo overlay, painel F1 e mensagens de erro. Por isso a interface some sozinha e precisa ser discreta.
- **"Sem sinal" só detecta a placa desconectada do USB.** Com a placa conectada e a fonte HDMI desligada, a imagem depende do que a placa envia (geralmente preto ou uma tela própria).
- **Na versão portátil, o .exe se extrai para uma pasta temporária e roda de lá.** Ao registrar no Discord, é preciso escolher o app **aberto** na lista, e não procurar o arquivo. O README vai explicar isso. O instalador NSIS não tem esse problema.
- **Sem assinatura de código,** o Windows SmartScreen mostra um aviso na primeira execução.
- **Resolução do stream:** 1080p60 no Go Live depende do plano do Discord. O app não controla isso.
- **"Ouvir este dispositivo"** do Windows deve ficar desligado para a placa, senão o som sai duplicado.

## Fase 6 — Tauri e áudio nativo

**Por quê:** o som da placa chegava atrasado em relação aos comandos do controle. A medida vai da captura da placa até a mixagem do Windows: correlação entre o som da placa e o loopback da saída, alinhados pelos carimbos QPC do WASAPI (ferramenta em `tools/medir-latencia`).

| Caminho | Atraso |
|---|---|
| Electron (Web Audio) | 117 a 140 ms |
| WASAPI nativo, com os efeitos do driver | 90 a 110 ms |
| **WASAPI nativo, saída em modo raw** | **65 a 69 ms** |
| App Tauri, baixa latência ligada / desligada | 66 ms / 111 ms |

- **A maior parte do atraso não vinha do Chromium,** mas da saída. No notebook de teste, os alto-falantes passam pelo Dolby APO e pelos efeitos da Realtek, e só a saída leva 83 ms (do pulso escrito no WASAPI até ele aparecer no loopback). Com `AUDCLNT_STREAMOPTIONS_RAW`, cai para 47 ms. O Chromium não tem como abrir um stream raw.
- **Sem efeito no Chromium:** `--audio-buffer-size`, `WebAudioBypassOutputBuffering`, `latencyHint: 0`. Tocar por `<audio srcObject>` é pior (60 ms a mais), e uma ponte própria (MediaStreamTrackProcessor → AudioWorklet) não melhorou com a placa real.
- **Períodos curtos não ajudam neste PC:** a saída Realtek e o motor de captura da placa recusam menos de 10 ms (IAudioClient3).

| Tema | Decisão | Motivo |
|---|---|---|
| Stack | Tauri 2 + WebView2, com a UI em JS puro como antes | O modo raw só é acessível por código nativo. O WebView2 também é Chromium, então `getUserMedia`, WebCodecs e WebRTC seguem iguais, e o app fica bem menor que os 308 MB do Electron |
| Motor de áudio | Uma thread com MMCSS "Pro Audio" atende os eventos da placa e da saída. A captura usa `AUTOCONVERTPCM` para o formato da saída. A saída usa `IAudioClient3`, com o menor período e `SetClientProperties(RAW, GameMedia)` | Mesmo desenho do protótipo medido |
| Fila | Alvo = um pacote da placa + um período da saída. Acima de alvo + um pacote, o mais antigo é descartado. A saída nunca é completada com silêncio | Silêncio escrito viraria atraso fixo. O descarte também evita o atraso acumulado por relógios diferentes (risco 3) |
| Baixa latência | Botão no overlay, ligado por padrão e salvo em `lowLatency`. Se o driver recusar o raw, o app abre o stream normal e o botão avisa | O som sem os efeitos do fabricante pode soar diferente. Quem preferir os efeitos desliga |
| Dispositivos | A lista de som da placa vem do WASAPI. O microfone do clipe continua na lista do Chromium. Os nomes casam com e sem o id USB no fim ("Placa" e "Placa (534d:2109)"), então a escolha salva no Electron continua valendo | O Chromium acrescenta o id USB ao nome do Windows |
| Troca de saída | `IMMNotificationClient`: uma nova saída padrão refaz a sessão. Dispositivo novo ou removido avisa o renderer, que roda o `sync()` | Fone conectado ou outra saída escolhida no Windows: o som acompanha |
| Som do PC nos clipes | Loopback WASAPI no Rust, em blocos de 10 ms por `Channel` binário, até um `AudioWorklet` no contexto dos clipes, com no máximo 100 ms na fila | No WebView2, o `getDisplayMedia` abriria o seletor de tela do Edge |
| Modo navegador | Com uma guia conectada, o app abre a placa também pelo `getUserMedia`, só para o WebRTC, e cala a saída nativa | O WebRTC precisa de uma faixa do Chromium |
| Permissões | `on_permission_request` concede câmera e microfone só para a origem do app. Na primeira abertura, `capture.js` faz um `getUserMedia` rápido, porque o WebView2 só revela ids e nomes depois de uma permissão | No Electron, o handler de checagem liberava os nomes sem pedido |
| Flags | As mesmas do Electron, em `additionalBrowserArgs`, mais `--autoplay-policy=no-user-gesture-required` e as do próprio Tauri (`msWebOOUI`, `msPdfOOUI`, `msSmartScreenProtection`). A coleção usa as mesmas flags | O WebView2 exige as mesmas flags em todas as janelas do app |
| Clipes no disco | Mesma pasta, mesmos nomes e `.thumbs`. O MP4 e a miniatura vão juntos num corpo binário do IPC. O protocolo `clip` (no WebView2, `http://clip.localhost`) responde a Range e limita pedidos abertos a 4 MB | Sem Range o player não avança |
| Configuração | `%APPDATA%\com.capturemirror.app\settings.json`. Na primeira abertura, copia a configuração do Electron, menos os limites da janela | Os limites agora são em pixels físicos, sem o ajuste à grade de pixels |

**Validado na placa:**
- Imagem: 720p a 57,3 FPS (o Electron dava 57 a 58) e 57,7 FPS com a janela coberta.
- Codificadores: H.264 por hardware disponível no WebView2 (no Electron, o sandbox da GPU bloqueava), além de AAC e Opus.
- Discord: encontrou a janela no Go Live.
- Clipes: clipe de 30 s em H.264 720p60, com AAC estéreo com som e miniatura. Atalho global com outra janela em foco, coleção com seek e Lixeira.
- Modo navegador: imagem e som na guia, e o som volta ao app quando a guia fecha.

**Falta testar:**
- O som numa transmissão real do Discord. Agora ele sai do próprio processo do app, e em modo raw.
- O aviso de clipe salvo e o clique nele.
- Arrastar um clipe para o Discord.
- A desconexão e a reconexão da placa.
- Uma sessão de 1 hora, por causa da deriva de relógio.
- O Meet numa call real.

## Fases

### Fase 1 — MVP
- Janela com título fixo, flags e permissões (seção "Decisões técnicas").
- Captura de vídeo e áudio com dispositivos separados, com a sequência de tentativas definida acima.
- Vídeo em tela inteira na janela (`object-fit: contain`, fundo preto, `muted`).
- Áudio pela Web Audio API.
- **Seletor simples de vídeo e áudio**, visível na tela até iniciar. A fase 1 precisa dele para escolher a placa, e a fase 2 o transforma no overlay. O áudio começa sem escolha, com a opção "Sem áudio", para um microfone não ser aberto por engano e causar microfonia.
- Log das capacidades do dispositivo.
- **Critério de aceite agora (com webcam):** imagem e som funcionam, o som toca sem clique e o FPS se mantém com a janela coberta.
- **Critério de aceite pendente (com placa e Go Live):** imagem e som saem no Discord em 1080p60 e os 3 riscos acima foram testados.

### Fase 2 — Usabilidade
- Interface conforme o protótipo feito a partir de [TELAS.md](TELAS.md). O overlay também aparece em "Sem sinal" e nos erros, o que o protótipo não mostra, para permitir escolher outro dispositivo. Esc fecha listas e sai da tela cheia, como no protótipo.
- Overlay discreto (aparece ao mover o mouse e some após 2 s) com seletores, volume e mute.
- Atalhos: F11 (tela cheia), M (mute), F1 (informações: resolução via `getSettings()`, FPS real via `requestVideoFrameCallback`).
- Cursor escondido quando parado.
- Configuração em `userData` (dispositivos, volume, tamanho e posição da janela), restaurada ao abrir. Se a posição salva estiver fora das telas atuais, a janela volta para a tela principal.
- `devicechange`: mostra "Sem sinal" e reconecta sozinho quando a placa voltar.
- Erro amigável para dispositivo em uso (`NotReadableError`, por exemplo com o OBS aberto).

### Fase 3 — Distribuição
- `electron-builder`: .exe portátil e instalador NSIS, com o ícone criado a partir de [TELAS.md](TELAS.md).
- README em português: como usar, como registrar em Configurações → Atividade registrada, como compartilhar pelo Go Live e as limitações acima.

### Fase 4 — Clipes
- Buffer de replay de 1 min com vídeo da placa, som do PC e microfone opcional. Clipes de 30 s e 1 min por atalho global ou botão.
- Coleção numa janela separada, com player, arrastar, Explorer e Lixeira.
- Ver a seção "Fase 4 — Clipes e coleção" para as decisões e as medições.

### Fase 5 — Modo navegador (Google Meet)
- O Meet (Chrome e Edge) só compartilha som de uma guia ou da tela inteira, nunca de uma janela. O app manda imagem e som por WebRTC para uma página local, e a pessoa compartilha essa guia.
- **Servidor:** `http` do Node em `127.0.0.1`, porta fixa 47830 para a guia se reconectar quando o app reinicia, com outra porta se ela estiver ocupada. Recusa `Host` diferente de `127.0.0.1`/`localhost` (DNS rebinding) e `POST` de outra origem. A sinalização usa SSE e `POST`, sem dependência nova.
- **Uma guia por vez.** Uma guia nova desconecta a anterior, que mostra "Usar esta guia".
- **Sem trickle ICE e sem STUN:** a oferta e a resposta vão com os candidatos completos, porque tudo é local.
- **Vídeo:** a própria faixa da placa, com `contentHint = "motion"` e H.264 preferido. Trocar placa ou resolução só faz `replaceTrack`. Com o dispositivo simulado, o envio usou o codificador por hardware (Intel Quick Sync), sem limitação.
- **Taxa:** a resposta da guia recebe `x-google-start-bitrate=12000` e `x-google-max-bitrate=30000` para a imagem não começar borrada, e Opus estéreo a 256 kbps em vez da taxa de voz.
- **Áudio:** `Gain → MediaStreamDestination`, então volume e mute valem para a guia. Enquanto a guia está conectada, um segundo ganho cala os alto-falantes do app, porque a guia toca o mesmo som. Na guia, `jitterBufferTarget = 0`.
- **Página:** pede um clique quando o navegador bloqueia som sem gesto, mostra "Sem sinal" pelo estado que o app envia e mostra por 8 s como compartilhar no Meet.
- **Testado** com o dispositivo simulado no navegador embutido: imagem 1280x720, som com sinal, troca de guia e reconexão depois de reiniciar o app. **Falta testar** com a placa e numa call real do Meet. Numa das execuções, uma guia reconectada mostrou "Sem sinal" com a imagem chegando. Isso não se repetiu em 3 tentativas, e a causa não foi encontrada.

### Possível fase futura (não implementar agora)
- Câmera e microfone virtuais, para usar no Meet e em apps de navegador.
