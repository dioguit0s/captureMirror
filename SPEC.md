# Capture Mirror — SPEC

App desktop para Windows que espelha vídeo e áudio de uma placa de captura USB (UVC) numa janela, para ser compartilhada no Discord (Go Live) como se fosse um jogo, com o áudio junto.

**Status:** fases 1, 2 e 3 implementadas, com o design do protótipo aplicado, e testadas com dispositivo simulado, webcam e placa real. Na placa, som e desconexão USB foram aprovados na versão portátil. O instalador NSIS foi executado e o app instalado abre e mostra o vídeo da placa. Falta testar o Go Live.

A **fase 4 (clipes e coleção)** foi implementada e testada com a placa real, mas sem a call do Discord. Os detalhes estão em "Fase 4" e "Clipes: medições".

## Arquitetura

```
Placa USB ──> getUserMedia (vídeo) ──> <video muted> ──────────> janela "Capture Mirror" ──> Discord
         └──> getUserMedia (áudio) ──> AudioContext ──> Gain ──> saída do processo ─────────> Discord

Clipes (fase 4):
vídeo (clone) ─> MediaStreamTrackProcessor ─> VideoEncoder H.264 ─┐
loopback do PC ─┬─> AudioContext próprio (sem saída) ─> AudioEncoder ┴─> buffer na RAM (~62 s)
microfone opc. ─┘                                                         │ atalho ou botão
                                           mediabunny (MP4) <─────────────┘ ─> main grava em Vídeos\Capture Mirror
```

- **Main process:** janela, permissões de mídia, flags do Chromium, leitura e gravação do JSON de configuração.
- **Preload:** ponte mínima via `contextBridge` (carregar e salvar configuração, alternar tela cheia).
- **Renderer:** captura, exibição, áudio e overlay. Toda a mídia fica aqui.

## Estrutura de pastas

```
captureMirror/
├─ package.json
├─ electron-builder.yml
├─ README.md
├─ SPEC.md
├─ TELAS.md                  # briefing de telas e ícone para o protótipo
├─ Main.dc.html, Icone.dc.html  # cópias do protótipo, só para referência
├─ design/                   # tokens e ícone originais
├─ build/icon.png            # ícone usado no empacotamento
└─ src/
   ├─ main/
   │  ├─ main.js             # janela, permissões, flags
   │  ├─ settings.js         # JSON em userData (fase 2)
   │  ├─ clips.js            # pasta, lista, gravação e protocolo clip:// dos clipes (fase 4)
   │  └─ preload.js          # fase 2: a fase 1 não precisa de ponte com o main
   └─ renderer/
      ├─ index.html
      ├─ style.css
      ├─ app.js              # orquestra tudo
      ├─ capture.js          # getUserMedia, fallback, capacidades
      ├─ audio.js            # AudioContext e GainNode
      ├─ overlay.js          # overlay, cursor e painel de informações
      ├─ select.js           # seletor de dispositivo do protótipo
      ├─ replay.js           # buffer de replay: encoders, pacotes na RAM, MP4 (fase 4)
      ├─ clipaudio.js        # loopback do PC + microfone opcional para os clipes (fase 4)
      └─ clips.html/.js/.css # janela da coleção (fase 4)
```

## Decisões técnicas

| Tema | Decisão | Motivo |
|---|---|---|
| Linguagem | JavaScript puro com módulos ES no renderer | Sem etapa de build. O projeto é pequeno |
| Dependências | `electron` e `electron-builder` para desenvolvimento. Na fase 4, `mediabunny` (MPL-2.0, sem dependências) em produção, importado direto de `node_modules` | Gerar MP4 à mão daria mais código para manter e mais risco de arquivo incompatível |
| Segurança | `contextIsolation` e `sandbox` ligados, `nodeIntegration` desligado, CSP restrita, só as permissões `media` e `display-capture` liberadas | Não há conteúdo remoto, mas o custo é zero. `display-capture` é para o loopback dos clipes |
| Dispositivo | `deviceId: { exact }` | Com `ideal`, o Chromium poderia trocar a placa pela webcam sem avisar |
| Vídeo | 1280x720 a 60 fps como `ideal`, escolha feita depois do teste com a placa (o pedido original era 1080p60). Se a abertura falhar, tenta de novo só com o `deviceId` | Em 1080p a placa testada mostra só 30 FPS. O modo vale para qualquer placa, então uma placa melhor também fica em 720p até haver uma opção de resolução |
| Áudio | Processamentos desligados, `channelCount: 2` e `sampleRate: 48000` | Conforme pedido |
| AudioContext | `latencyHint: "interactive"`, `sampleRate: 48000` e `autoplayPolicy: "no-user-gesture-required"` | Evita reamostragem e garante que o som toque sem clique ao abrir |
| Volume e mute | `MediaStreamSource → GainNode → destination` | Necessário para o volume da fase 2. Sem efeito perceptível na latência |
| Salvar dispositivos | Guarda `deviceId` **e** `label`. Restaura pelo id e, se falhar, pelo label | O `deviceId` do Chromium pode mudar. O label é mais estável |
| Janela | Moldura nativa, sem menu, área de conteúdo inicial de 1280x720, mínima de 640x360, título travado via `page-title-updated` | Comportamento de um jogo em janela comum |
| Atalho M | Mostra o overlay por 2 s ao alternar o mute | Confirma visualmente o estado, já que mute silencia também o stream |
| Mute | Não é salvo: o app sempre abre com som | Abrir silenciado sem aviso deixaria o stream mudo |
| Posição da janela | Ao restaurar, é alinhada à grade de pixels físicos | Com escala fracionária, o Chromium aumenta a janela se a posição cair entre pixels, e ela cresceria a cada abertura |
| Reconexão | `sync()` compara o dispositivo escolhido com o aberto, a cada `devicechange` e a cada 1,5 s enquanto falta algo | O `devicechange` pode disparar antes de a placa estar pronta |
| Dispositivo em uso | Só mostra o erro após 3 tentativas falhas. Depois, espera "Tentar novamente" ou um `devicechange` | Logo após reconectar, a placa pode recusar a abertura por alguns instantes |
| Overlay em "Sem sinal" e em erro | Continua disponível | Permite escolher outro dispositivo se a placa salva não voltar |
| Seletores | Componente próprio (`select.js`), como no protótipo, e não `<select>` nativo | O Chromium não avisa quando a lista nativa abre ou fecha. Com o próprio, o overlay fica visível enquanto a lista está aberta |
| Ícone | `build/icon.png`, cópia de `design/icone/capture-mirror.png`. O electron-builder gera o `.ico` | Mantém uma única fonte para o ícone |

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
| Som do PC | Loopback do dispositivo padrão via `getDisplayMedia` + `setDisplayMediaRequestHandler` (`audio: 'loopback'`). A tela capturada junto é parada na hora | É a única forma de pegar o som do sistema no Chromium. O som da placa entra porque o app o toca, sem duplicar. Volume e mute do app valem para o clipe. Não precisou de gesto do usuário |
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

### Possível fase futura (não implementar agora)
- Câmera e microfone virtuais, para usar no Meet e em apps de navegador.
