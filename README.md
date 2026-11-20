# Capture Mirror

Espelha a imagem e o som de uma placa de captura USB numa janela. Você compartilha essa janela no Discord (Go Live) como se fosse um jogo aberto, e o áudio vai junto. Também dá para compartilhar com som no Google Meet, por uma guia do navegador.

Funciona no Windows 10 ou mais recente, com placas de captura USB comuns (UVC). Usa o WebView2 da Microsoft, que já vem no Windows 10 e 11 atualizados.

## Qual arquivo usar

Os arquivos são gerados pelo build (veja [Desenvolvimento](#desenvolvimento)).

| Arquivo | Quando usar |
|---|---|
| `Capture Mirror_0.3.0_x64-setup.exe` (em `src-tauri/target/release/bundle/nsis`) | **Recomendado.** Instala só para o seu usuário e cria um atalho. Se o WebView2 faltar, o instalador baixa |
| `Capture Mirror.exe` (em `src-tauri/target/release`) | Versão portátil: roda sem instalar, de qualquer pasta. Tem o mesmo nome do executável das versões anteriores, então o Discord continua reconhecendo o app |

Os arquivos não têm assinatura digital, então o Windows pode mostrar um aviso do SmartScreen na primeira vez. Para continuar, clique em **Mais informações** e depois em **Executar assim mesmo**.

## Como usar

1. Conecte a placa de captura ao USB e feche outros programas que usem a placa, como o OBS.
2. Abra o Capture Mirror.
3. Em **Vídeo**, escolha a placa. Em **Áudio**, escolha a entrada de áudio da placa.
4. Clique em **Iniciar**.

Nas próximas vezes, o app abre direto na imagem, com os mesmos dispositivos, volume, tamanho e posição.

Mova o mouse para ver os controles de dispositivo, resolução, mute e volume. Eles somem depois de 2 segundos com o mouse parado, junto com o cursor.

### Baixa latência

O botão com um raio, ao lado do volume, deixa o som da placa com o menor atraso possível. Ele vem ligado.

O som da placa toca direto pelo áudio do Windows, sem passar pelo navegador interno do app. Com o botão ligado, ele também pula os efeitos de som do Windows e do fabricante, como o Dolby. No notebook de teste, o atraso entre a placa e o som sair caiu de ~125 ms (versão anterior do app) para ~65 ms.

Sem esses efeitos, o som pode ficar um pouco diferente nos alto-falantes do notebook. Se preferir o som com efeitos, desligue o botão. O atraso volta a ~110 ms.

### Resolução

O seletor com ícone de monitor, ao lado da placa, escolhe a resolução da imagem: 1080p, 720p ou 480p (e 1440p ou 4K, se a placa suportar). A escolha fica salva. O padrão é 720p porque algumas placas baratas, como a MS2109, só entregam 30 FPS em 1080p. Aperte F1 para ver a resolução e o FPS que chegam de verdade.

Trocar a resolução reabre a placa por um instante e recomeça a memória dos clipes.

### Atalhos

| Tecla | Ação |
|---|---|
| F11 | Entra ou sai da tela cheia |
| Esc | Fecha uma lista aberta ou sai da tela cheia |
| M | Liga ou desliga o mute |
| F1 | Mostra ou esconde a resolução e o FPS reais |

## Clipes

Enquanto a imagem está no ar, o app guarda os últimos 5 minutos na memória. Nada vai para o disco até você clipar. Um ponto vermelho no overlay indica que isso está ativo.

| Atalho | Clipe |
|---|---|
| Ctrl+Shift+F9 | Últimos 30 segundos |
| Ctrl+Shift+F10 | Último minuto |
| Ctrl+Shift+F11 | Últimos 5 minutos |

Os atalhos funcionam mesmo com outra janela em foco, como o Discord ou um jogo. Também dá para clipar pelos botões **30 s**, **1 min** e **5 min** do overlay. O Windows avisa com uma notificação quando o clipe é salvo.

**O que entra no clipe:**
- A imagem da placa.
- **Todo o som do PC:** a placa (que o app está tocando), a call do Discord e qualquer outro som. O app grava o que sai no dispositivo de áudio **padrão** do Windows. Se o Discord sair em outro dispositivo, a call não entra.
- **Seu microfone, se você quiser.** Escolha o microfone no controle com ícone de microfone do overlay. Ele entra só no clipe: não sai nos alto-falantes nem na transmissão. Comece com **Sem microfone no clipe**.

Volume e mute do app também valem para o clipe. Com o mute ligado, o som da placa não entra.

Os clipes são salvos em MP4 (H.264 e AAC) em `Vídeos\Capture Mirror`. Um clipe de 1 minuto ocupa de 10 a 70 MB, conforme a imagem, e um de 5 minutos, até ~350 MB.

Guardar 5 minutos usa memória: em 1080p, o buffer cheio ocupa ~375 MB de RAM, e em 720p, um pouco menos.

### Coleção

O botão com quatro quadrados no overlay abre a coleção numa **janela separada**, que não aparece no Go Live. Na coleção, você pode:
- Clicar num clipe para assistir.
- **Arrastar** o clipe para o Discord ou para uma pasta.
- Mostrar o arquivo no Explorer.
- Mover o clipe para a Lixeira.

## Como compartilhar no Discord

1. Com o Capture Mirror aberto, vá ao Discord em **Configurações → Atividade registrada**.
2. Clique em **Adicione-o!** e escolha o **Capture Mirror** na lista de programas abertos.
3. Entre num servidor. O Capture Mirror aparece no painel inferior, perto do seu nome. Clique no botão de transmitir (**Go Live**) ao lado dele.
4. Escolha o canal de voz e a qualidade, e inicie a transmissão.

**Na versão portátil, sempre escolha o app na lista de programas abertos.** Essa versão roda a partir de uma pasta temporária, então procurar o arquivo manualmente pode não funcionar.

Os nomes dos menus podem mudar conforme a versão do Discord.

## Como compartilhar no Google Meet (com som)

O Meet roda no navegador, e o navegador não compartilha o som de uma janela, só de uma **guia** ou da tela inteira. Por isso o app manda a imagem e o som para uma guia, e você compartilha essa guia.

1. Com a imagem no ar, mova o mouse e clique no botão da direita do overlay (**Abrir numa guia do navegador**). A página abre no navegador padrão. Use o Chrome ou o Edge, porque o Firefox não compartilha som de guias.
2. Se a página pedir, clique em **Começar**. O navegador só toca som depois de um clique.
3. No Meet, clique em **Apresentar → Uma guia**, escolha a guia **Capture Mirror** e deixe ligado **Compartilhar também o áudio da guia**.

Enquanto a guia está conectada, o botão fica azul, e **o som passa a sair pela guia**, não pelo app, para não tocar dobrado. Volume e mute do app continuam valendo. Feche a guia para o som voltar ao app.

- A guia se reconecta sozinha se o app for fechado e aberto de novo.
- Uma guia por vez: abrir outra desconecta a anterior.
- A página só aceita conexões do próprio PC (`http://127.0.0.1:47830`). Se essa porta estiver ocupada, o app usa outra, e a guia precisa ser aberta de novo pelo botão.
- Na guia, o som chega alguns milissegundos depois da imagem do app. Para quem está na call, imagem e som chegam juntos.

## Bom saber

- **Volume e mute também afetam a transmissão.** O Discord captura o som que sai do app. Com o mute ligado, quem assiste também fica sem som.
- **Quem assiste vê tudo o que aparece na janela,** incluindo os controles, o painel do F1 e as mensagens de erro.
- **Deixe a janela aberta, sem minimizar.** Ela pode ficar atrás de outras janelas sem perder imagem no app, mas minimizada não é um caso compatível.
- **Som duplicado?** Desligue a opção **Ouvir este dispositivo** da placa nas configurações de som do Windows.
- **O app captura em 720p a 60 FPS.** Foi o melhor modo medido na placa testada: em 1080p, ela mostra só 30 FPS. A qualidade final no Go Live depende do seu plano do Discord, e o app não controla isso.

## Problemas comuns

| O que aparece | O que fazer |
|---|---|
| **Placa em uso por outro aplicativo** | Feche o outro programa, como o OBS, e clique em **Tentar novamente** |
| **Sem sinal** | Confira o cabo USB. O app reconecta sozinho quando a placa voltar |
| Imagem preta com a placa conectada | Confira se o aparelho ligado à placa está ligado e enviando imagem. O aviso "Sem sinal" só aparece quando a placa sai do USB |
| **Dispositivo de áudio desconectado** | Mova o mouse e escolha a entrada de áudio da placa no controle de áudio |
| FPS abaixo do esperado | Pressione F1 para ver os valores reais. Nas webcams, pouca luz também reduz o FPS |
| Som em mono | É o que a placa testada oferece: ela se apresenta ao Windows como mono |
| **Os clipes estão sem o som do PC** | O Windows não entregou o som do sistema. Reinicie o app. Se continuar, confira o dispositivo de saída padrão |
| **Atalho em uso por outro aplicativo** | Outro programa já usa Ctrl+Shift+F9, F10 ou F11. Use os botões do overlay ou feche o outro programa e reabra o app |

## Onde ficam as configurações

Em `%APPDATA%\com.capturemirror.app\settings.json`. Na primeira abertura, a versão nova aproveita os dispositivos, o volume e a resolução da versão anterior (`%APPDATA%\Capture Mirror\settings.json`). Para voltar à tela de configuração inicial, feche o app e apague o arquivo novo.

## Estado dos testes

A versão 0.3.0 (Tauri) foi testada com a placa de captura (ID USB 534D:2109): imagem a 57 FPS em 720p (também com a janela coberta), som pela saída nativa com e sem baixa latência, clipes por botão e por atalho global, coleção com seek e Lixeira, e modo navegador com imagem e som na guia. O Discord encontrou a janela no Go Live. **Ainda não foram testados:** o som numa transmissão real do Discord, arrastar um clipe para o Discord, o aviso de clipe salvo, a desconexão do USB nesta versão e o Meet numa call real. Os resultados e os pontos em aberto estão em [SPEC.md](SPEC.md).

## Desenvolvimento

Requer Node.js e Rust (toolchain `stable-x86_64-pc-windows-msvc`, com as Ferramentas de Build do Visual Studio 2022). O app é [Tauri 2](https://tauri.app): a interface continua em HTML e JavaScript puro em `src/`, sem etapa de build, e o lado nativo fica em `src-tauri/` (Rust). A única dependência JavaScript de execução é o [mediabunny](https://mediabunny.dev) (MPL-2.0), que monta o MP4 dos clipes. O `npm run vendor` copia o bundle dele para `src/renderer/vendor`.

```bash
npm install
```

Para rodar o app:

```bash
npm run dev
```

Para gerar o instalador e o executável:

```bash
npm run build
```

Em modo dev, o clique direito abre as ferramentas de desenvolvedor, e as capacidades do dispositivo aparecem no console delas.

Para medir o atraso do som, há duas ferramentas em `tools/medir-latencia` (compile com `build.bat`):
- Com o app tocando, `passthrough.exe --sem-som` mede o atraso entre a placa e o som que sai no Windows. Precisa de som saindo do console.
- `pulse.exe [--raw]` mede só o lado da saída.
