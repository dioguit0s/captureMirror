# Capture Mirror — briefing de telas

Crie um protótipo interativo em HTML/CSS das telas abaixo e o ícone do app.

## O produto

Capture Mirror é um app desktop para Windows que mostra numa janela a imagem e o som de uma placa de captura USB, como a de um videogame. A pessoa compartilha essa janela no Discord como se fosse um jogo aberto.

O app é quase só vídeo. A interface aparece raramente, e **quem assiste à transmissão também a vê**. Por isso, ela precisa ser discreta e nunca competir com a imagem.

## Direção visual

- Tema escuro único, sobre fundo preto. Os controles flutuam sobre o vídeo, que pode ser claro ou escuro, então precisam continuar legíveis nos dois casos.
- Aparência de ferramenta sóbria. Evite a estética "gamer" (neon, ângulos agressivos, brilhos).
- Fonte do sistema (Segoe UI), porque o app funciona sem internet.
- Ícones em SVG inline, sem bibliotecas de UI ou CSS.
- Animações só de fade curto ao aparecer e sumir.
- Textos em português do Brasil.

## Janela

- Moldura nativa do Windows, com o título "Capture Mirror". Não desenhe barra de título própria.
- Tamanho inicial da área de conteúdo: 1280x720. Mínimo: 640x360. Também abre em tela cheia.
- Todas as telas precisam funcionar em 640x360 e em 1920x1080.
- Para simular o vídeo no protótipo, use uma imagem de jogo de exemplo e deixe fácil trocá-la por uma imagem clara.

## Telas

### 1. Configuração inicial

Aparece quando não há dispositivo salvo. Fundo preto, com um bloco central compacto.

- Nome do app.
- Seletor "Vídeo", com a lista de dispositivos.
- Seletor "Áudio", com a lista de dispositivos.
- Botão principal "Iniciar".

Os nomes de dispositivo podem ser longos e devem ser cortados com reticências, sem quebrar o layout. Exemplos: "USB3.0 Capture Video", "720p HD Camera", "Iriun Webcam".

**Variação, nenhum dispositivo encontrado:** mensagem "Nenhuma placa de captura encontrada. Conecte a placa ao USB." O botão fica desabilitado. A tela atualiza sozinha quando a placa é conectada, então não precisa de botão "Atualizar".

### 2. Espelho

É a tela principal, onde o app passa quase todo o tempo. Só o vídeo, ocupando a janela inteira, com barras pretas se a proporção for diferente. **Nenhum elemento de interface**, e o cursor fica escondido.

### 3. Overlay de controles

Aparece sobre o vídeo ao mover o mouse e some após 2 s parado. Também aparece por 2 s ao pressionar M. Não fica fixo enquanto o mouse está parado, exceto com um seletor aberto.

Prefira uma barra compacta na parte inferior, cobrindo o mínimo possível do vídeo. Contém:

- Seletor de vídeo.
- Seletor de áudio.
- Botão de mute, com estados ligado e silenciado bem distintos.
- Controle de volume (0 a 100%).

Em 640x360, todos os controles precisam continuar acessíveis.

**Variação, silenciado:** deixe claro que o som também não vai para a transmissão, sem usar um alerta chamativo.

### 4. Painel de informações (F1)

Bloco pequeno de texto em um canto, com fundo semitransparente. Fica visível até pressionar F1 de novo e é independente do overlay.

- Resolução real, por exemplo "1920 x 1080".
- FPS real, por exemplo "59,9 FPS".

Use algarismos de largura fixa para os números não "dançarem" enquanto mudam.

### 5. Sem sinal

Aparece quando a placa é desconectada. Fundo preto, com a mensagem central "Sem sinal" e, em texto menor, "Reconectando automaticamente quando a placa voltar". Sem botões. Pode ser vista por quem assiste durante vários minutos, então deve ser limpa e sem animação chamativa.

### 6. Dispositivo em uso

Aparece quando outro app está usando a placa. Fundo preto, com bloco central:

- Título: "Placa em uso por outro aplicativo".
- Texto: "Feche o outro programa que está usando a placa, como o OBS, e tente de novo."
- Botão "Tentar novamente".

## Atalhos

Inclua no protótipo: **F11** alterna tela cheia, **M** alterna mute e **F1** mostra ou esconde as informações. Não desenhe uma tela de ajuda.

## Fora do escopo

Não crie telas de login, conta, gravação, configurações avançadas, tema claro ou escolha de resolução. Também não crie um botão para iniciar a transmissão, porque isso é feito no Discord.

## Ícone do app

- Conceito: espelhamento de uma tela, ou seja, uma imagem refletida ou duplicada. Evite controles de videogame e o logo do Discord.
- Forma simples, reconhecível em 16x16 e 32x32 na barra de tarefas e na lista do Discord.
- Funciona sobre fundo claro e escuro.
- Entrega: SVG e PNG de 1024x1024 com fundo transparente.

## Entrega

1. Um único protótipo navegável, com uma forma simples de alternar entre as 6 telas e suas variações.
2. Cores, tamanhos e espaçamentos definidos como variáveis CSS, para facilitar a implementação no app.
3. O ícone nos formatos acima.
