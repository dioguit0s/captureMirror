# Capture Mirror

Espelha a imagem e o som de uma placa de captura USB numa janela. Você compartilha essa janela no Discord (Go Live) como se fosse um jogo aberto, e o áudio vai junto.

Funciona no Windows 10 ou mais recente, com placas de captura USB comuns (UVC).

## Qual arquivo usar

Os arquivos ficam na pasta `dist` depois do build (veja [Desenvolvimento](#desenvolvimento)).

| Arquivo | Quando usar |
|---|---|
| `Capture-Mirror-Setup-0.2.0.exe` | **Recomendado.** Instala só para o seu usuário e cria um atalho. Também atualiza uma versão já instalada, mantendo as configurações |
| `Capture-Mirror-Portatil-0.2.0.exe` | Para rodar sem instalar. Demora um pouco mais para abrir |

Os arquivos não têm assinatura digital, então o Windows pode mostrar um aviso do SmartScreen na primeira vez. Para continuar, clique em **Mais informações** e depois em **Executar assim mesmo**.

## Como usar

1. Conecte a placa de captura ao USB e feche outros programas que usem a placa, como o OBS.
2. Abra o Capture Mirror.
3. Em **Vídeo**, escolha a placa. Em **Áudio**, escolha a entrada de áudio da placa.
4. Clique em **Iniciar**.

Nas próximas vezes, o app abre direto na imagem, com os mesmos dispositivos, volume, tamanho e posição.

Mova o mouse para ver os controles de dispositivo, mute e volume. Eles somem depois de 2 segundos com o mouse parado, junto com o cursor.

### Atalhos

| Tecla | Ação |
|---|---|
| F11 | Entra ou sai da tela cheia |
| Esc | Fecha uma lista aberta ou sai da tela cheia |
| M | Liga ou desliga o mute |
| F1 | Mostra ou esconde a resolução e o FPS reais |

## Clipes

Enquanto a imagem está no ar, o app guarda o último minuto na memória. Nada vai para o disco até você clipar. Um ponto vermelho no overlay indica que isso está ativo.

| Atalho | Clipe |
|---|---|
| Ctrl+Shift+F9 | Últimos 30 segundos |
| Ctrl+Shift+F10 | Último minuto |

Os atalhos funcionam mesmo com outra janela em foco, como o Discord ou um jogo. Também dá para clipar pelos botões **30 s** e **1 min** do overlay. O Windows avisa com uma notificação quando o clipe é salvo.

**O que entra no clipe:**
- A imagem da placa.
- **Todo o som do PC:** a placa (que o app está tocando), a call do Discord e qualquer outro som. O app grava o que sai no dispositivo de áudio **padrão** do Windows. Se o Discord sair em outro dispositivo, a call não entra.
- **Seu microfone, se você quiser.** Escolha o microfone no controle com ícone de microfone do overlay. Ele entra só no clipe: não sai nos alto-falantes nem na transmissão. Comece com **Sem microfone no clipe**.

Volume e mute do app também valem para o clipe. Com o mute ligado, o som da placa não entra.

Os clipes são salvos em MP4 (H.264 e AAC) em `Vídeos\Capture Mirror`. Um clipe de 1 minuto ocupa de 10 a 60 MB, conforme a imagem.

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
| **Atalho em uso por outro aplicativo** | Outro programa já usa Ctrl+Shift+F9 ou F10. Use os botões do overlay ou feche o outro programa e reabra o app |

## Onde ficam as configurações

Em `%APPDATA%\Capture Mirror\settings.json`. Para voltar à tela de configuração inicial, feche o app e apague esse arquivo.

## Estado dos testes

O app foi testado com um dispositivo simulado do Chromium, uma webcam e uma placa de captura (ID USB 534D:2109), incluindo a escuta do som e a desconexão do USB. **Ainda não foi testado transmitindo no Go Live.** Os clipes foram testados com a placa e com som do PC, mas ainda não numa call real do Discord. Os resultados e os pontos em aberto estão em [SPEC.md](SPEC.md).

## Desenvolvimento

Requer Node.js. A única dependência de execução é o [mediabunny](https://mediabunny.dev) (MPL-2.0), que monta o MP4 dos clipes. O renderer importa o bundle ESM direto de `node_modules`, sem etapa de build.

```bash
npm install
```

Para rodar o app:

```bash
npm start
```

Para gerar os executáveis em `dist`:

```bash
npm run dist
```

Com o app rodando por `npm start`, as capacidades do dispositivo aparecem no terminal, e F12 abre as ferramentas de desenvolvedor.
