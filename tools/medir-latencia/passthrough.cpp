// Ferramenta de medição (foi o protótipo do motor de áudio do app): leva o som da
// placa direto para a saída pelo WASAPI e mede o atraso entre a captura da placa e
// a mixagem do Windows. Com --sem-som, só mede, e serve para medir o próprio app.
//
// A medida é a mesma usada no app Electron: correlação entre o som da placa e o
// loopback da saída, alinhados pelos carimbos QPC que o próprio WASAPI entrega.
//
// Uso: passthrough.exe [trecho do nome da placa] [segundos] [--sem-som] [--periodo-padrao]
//   --sem-som          não toca nada; só mede (para medir outra instância tocando).
//   --periodo-padrao   não pede o período curto do IAudioClient3 na saída.
//   --com-efeitos      não pede o modo raw; o som passa pelos efeitos do driver (Dolby etc.).
//   --captura-curta    lê a placa no formato dela com o menor período (IAudioClient3)
//                      e converte aqui, em vez de deixar o Windows converter.

#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")

#define CHECK(expr)                                                                \
  do {                                                                             \
    HRESULT hr_ = (expr);                                                          \
    if (FAILED(hr_)) {                                                             \
      std::fprintf(stderr, "falhou: %s (0x%08lX) linha %d\n", #expr, hr_, __LINE__); \
      std::exit(1);                                                                \
    }                                                                              \
  } while (0)

template <class T>
void release(T*& p) {
  if (p) p->Release();
  p = nullptr;
}

// Todo o processamento é em float, no formato da saída.
struct Format {
  int rate = 0;
  int channels = 0;
};

static bool isFloat(const WAVEFORMATEX* wf) {
  if (wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
  if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    auto ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wf);
    return ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
  }
  return false;
}

static std::wstring friendlyName(IMMDevice* device) {
  IPropertyStore* store = nullptr;
  std::wstring name;
  if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &store))) {
    PROPVARIANT value;
    PropVariantInit(&value);
    if (SUCCEEDED(store->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR) name = value.pwszVal;
    PropVariantClear(&value);
    store->Release();
  }
  return name;
}

static IMMDevice* findCapture(IMMDeviceEnumerator* enumerator, const std::wstring& part) {
  IMMDeviceCollection* devices = nullptr;
  CHECK(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &devices));
  UINT count = 0;
  devices->GetCount(&count);
  IMMDevice* found = nullptr;
  for (UINT i = 0; i < count && !found; i += 1) {
    IMMDevice* device = nullptr;
    devices->Item(i, &device);
    if (friendlyName(device).find(part) != std::wstring::npos) found = device;
    else device->Release();
  }
  devices->Release();
  return found;
}

// Gravação reduzida a 8 kHz mono para a correlação, com o QPC do primeiro quadro.
struct Recording {
  std::mutex lock;
  std::vector<float> samples;
  long long firstQpc = -1;  // em 100 ns
  int rate = 0;
  double acc = 0;
  int count = 0;
  int step = 1;
  int discontinuities = 0;

  void start(int sampleRate) {
    rate = sampleRate;
    step = sampleRate / 8000;
  }

  void push(const float* data, UINT32 frames, int channels, UINT64 qpc, bool silent) {
    std::lock_guard<std::mutex> guard(lock);
    if (firstQpc < 0) firstQpc = static_cast<long long>(qpc);
    for (UINT32 f = 0; f < frames; f += 1) {
      double mono = 0;
      if (!silent)
        for (int c = 0; c < channels; c += 1) mono += data[f * channels + c];
      acc += mono / channels;
      if (++count == step) {
        samples.push_back(static_cast<float>(acc / step));
        acc = 0;
        count = 0;
      }
    }
  }
};

// Fila entre a captura e a saída, em quadros do formato da saída.
struct Ring {
  std::vector<float> data;
  size_t channels = 2;
  size_t head = 0;  // próxima leitura
  size_t size = 0;  // quadros guardados

  void init(size_t capacityFrames, size_t ch) {
    channels = ch;
    data.assign(capacityFrames * ch, 0.0f);
  }
  size_t capacity() const { return data.size() / channels; }

  void write(const float* frames, size_t count) {
    for (size_t i = 0; i < count; i += 1) {
      if (size == capacity()) {  // cheia: descarta o mais antigo
        head = (head + 1) % capacity();
        size -= 1;
      }
      size_t tail = (head + size) % capacity();
      std::copy(frames + i * channels, frames + (i + 1) * channels, data.begin() + tail * channels);
      size += 1;
    }
  }

  void read(float* out, size_t count) {
    for (size_t i = 0; i < count; i += 1) {
      std::copy(data.begin() + head * channels, data.begin() + (head + 1) * channels, out + i * channels);
      head = (head + 1) % capacity();
    }
    size -= count;
  }

  void drop(size_t count) {
    head = (head + count) % capacity();
    size -= count;
  }
};

static std::atomic<bool> running{true};

// Correlação normalizada do loopback contra a placa, alinhados pelo QPC.
static void correlate(Recording& card, Recording& loop, double skipSeconds) {
  std::vector<float> a, b;
  long long a0, b0;
  {
    std::lock_guard<std::mutex> g1(card.lock), g2(loop.lock);
    a = card.samples;
    b = loop.samples;
    a0 = card.firstQpc;
    b0 = loop.firstQpc;
  }
  if (a.empty() || b.empty()) {
    std::printf("sem dados para medir\n");
    return;
  }
  // Índice no loopback do instante em que a placa começou (8 kHz = 1250 unidades de 100 ns).
  long long shift = (a0 - b0) / 1250;
  const int maxLag = 8 * 400;  // até 400 ms
  size_t start = static_cast<size_t>(skipSeconds * 8000);
  size_t n = 0;
  if (a.size() > start) n = a.size() - start;
  long long room = static_cast<long long>(b.size()) - shift - maxLag - static_cast<long long>(start);
  if (room < static_cast<long long>(n)) n = room > 0 ? static_cast<size_t>(room) : 0;
  if (n < 8000 || shift + static_cast<long long>(start) < 0) {
    std::printf("trecho curto demais para medir (n=%zu, shift=%lld)\n", n, shift);
    return;
  }
  double energyA = 0;
  for (size_t i = 0; i < n; i += 1) energyA += a[start + i] * a[start + i];
  std::vector<std::pair<double, int>> scores;
  for (int lag = 0; lag < maxLag; lag += 1) {
    double s = 0, e = 0;
    const float* pb = b.data() + shift + start + lag;
    const float* pa = a.data() + start;
    for (size_t i = 0; i < n; i += 1) {
      s += pa[i] * pb[i];
      e += pb[i] * pb[i];
    }
    scores.push_back({s / std::sqrt(energyA * e + 1e-12), lag});
  }
  std::sort(scores.begin(), scores.end(), [](auto& x, auto& y) { return x.first > y.first; });
  std::vector<std::pair<double, int>> best;
  for (auto& item : scores) {
    if (best.size() >= 4) break;
    bool close = false;
    for (auto& kept : best) close = close || std::abs(kept.second - item.second) < 24;
    if (!close) best.push_back(item);
  }
  std::printf("energia da placa: %.6f (perto de zero = sem som; a medida não vale)\n", energyA / n);
  std::printf("atrasos placa -> mixagem (maior correlação primeiro):\n");
  for (auto& item : best) std::printf("  %6.1f ms  correlação %.3f\n", item.second / 8.0, item.first);
}

int wmain(int argc, wchar_t** argv) {
  std::wstring cardName = L"USB Digital Audio";
  double seconds = 12;
  bool play = true;
  bool lowLatency = true;
  bool raw = true;
  bool shortCapture = false;
  int positional = 0;
  for (int i = 1; i < argc; i += 1) {
    std::wstring arg = argv[i];
    if (arg == L"--sem-som") play = false;
    else if (arg == L"--periodo-padrao") lowLatency = false;
    else if (arg == L"--com-efeitos") raw = false;
    else if (arg == L"--captura-curta") shortCapture = true;
    else if (positional++ == 0) cardName = arg;
    else seconds = _wtof(argv[i]);
  }

  CHECK(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
  IMMDeviceEnumerator* enumerator = nullptr;
  CHECK(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)));

  IMMDevice* cardDevice = findCapture(enumerator, cardName);
  if (!cardDevice) {
    std::fwprintf(stderr, L"placa não encontrada: %ls\n", cardName.c_str());
    return 1;
  }
  IMMDevice* outDevice = nullptr;
  CHECK(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &outDevice));
  std::wprintf(L"placa: %ls\nsaída: %ls\n", friendlyName(cardDevice).c_str(), friendlyName(outDevice).c_str());

  // Saída: formato de mixagem, período curto se o driver permitir.
  IAudioClient3* out = nullptr;
  CHECK(outDevice->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&out)));
  WAVEFORMATEX* outFormat = nullptr;
  CHECK(out->GetMixFormat(&outFormat));
  if (!isFloat(outFormat)) {
    std::fprintf(stderr, "formato de saída não é float\n");
    return 1;
  }
  Format fmt{static_cast<int>(outFormat->nSamplesPerSec), outFormat->nChannels};
  // Modo raw: o Windows pula os efeitos do driver só neste stream. Nos alto-falantes
  // com Dolby, os efeitos seguram uns 35 ms de som.
  if (raw) {
    AudioClientProperties props = {};
    props.cbSize = sizeof(props);
    props.eCategory = AudioCategory_GameMedia;
    props.Options = AUDCLNT_STREAMOPTIONS_RAW;
    HRESULT hr = out->SetClientProperties(&props);
    std::printf("saída: modo raw %s\n", SUCCEEDED(hr) ? "ligado" : "recusado pelo driver");
  }
  UINT32 defPeriod = 0, fundPeriod = 0, minPeriod = 0, maxPeriod = 0;
  CHECK(out->GetSharedModeEnginePeriod(outFormat, &defPeriod, &fundPeriod, &minPeriod, &maxPeriod));
  std::printf("saída: %d Hz, %d canais; períodos do motor: padrão %u, mínimo %u, máximo %u quadros\n", fmt.rate,
              fmt.channels, defPeriod, minPeriod, maxPeriod);
  HANDLE outEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  UINT32 outPeriod = lowLatency ? minPeriod : defPeriod;
  CHECK(out->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, outPeriod, outFormat, nullptr));
  CHECK(out->SetEventHandle(outEvent));
  UINT32 outBufferFrames = 0;
  CHECK(out->GetBufferSize(&outBufferFrames));
  REFERENCE_TIME outLatency = 0;
  out->GetStreamLatency(&outLatency);
  IAudioRenderClient* render = nullptr;
  CHECK(out->GetService(IID_PPV_ARGS(&render)));
  std::printf("saída: período %u quadros (%.2f ms), buffer %u quadros, latência do stream %.2f ms\n", outPeriod,
              outPeriod * 1000.0 / fmt.rate, outBufferFrames, outLatency / 10000.0);

  // Placa: o Windows converte para o formato da saída (taxa e canais).
  IAudioClient3* in = nullptr;
  CHECK(cardDevice->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&in)));
  WAVEFORMATEX* cardMix = nullptr;
  CHECK(in->GetMixFormat(&cardMix));
  std::printf("placa (formato do Windows): %lu Hz, %u canais, %u bits\n", cardMix->nSamplesPerSec, cardMix->nChannels,
              cardMix->wBitsPerSample);
  REFERENCE_TIME inDefault = 0, inMin = 0;
  in->GetDevicePeriod(&inDefault, &inMin);
  HANDLE inEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  // Conversão própria: só taxa igual à da saída ou o dobro dela, em float.
  int cardRate = static_cast<int>(cardMix->nSamplesPerSec), cardChannels = cardMix->nChannels;
  bool convert = shortCapture && isFloat(cardMix) && (cardRate == fmt.rate || cardRate == 2 * fmt.rate);
  if (shortCapture && !convert) std::printf("placa: formato sem conversão própria; o Windows converte\n");
  if (convert) {
    UINT32 d = 0, f = 0, mn = 0, mx = 0;
    CHECK(in->GetSharedModeEnginePeriod(cardMix, &d, &f, &mn, &mx));
    CHECK(in->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, mn, cardMix, nullptr));
    std::printf("placa: período curto %u quadros (%.2f ms), conversão própria %d Hz -> %d Hz\n", mn,
                mn * 1000.0 / cardRate, cardRate, fmt.rate);
  } else {
    CHECK(in->Initialize(AUDCLNT_SHAREMODE_SHARED,
                         AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                             AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                         0, 0, outFormat, nullptr));
  }
  CHECK(in->SetEventHandle(inEvent));
  REFERENCE_TIME inLatency = 0;
  in->GetStreamLatency(&inLatency);
  IAudioCaptureClient* capture = nullptr;
  CHECK(in->GetService(IID_PPV_ARGS(&capture)));
  std::printf("placa: período do dispositivo %.2f ms (mínimo %.2f), latência do stream %.2f ms\n", inDefault / 10000.0,
              inMin / 10000.0, inLatency / 10000.0);

  // Loopback da saída, só para medir.
  IAudioClient* loopClient = nullptr;
  CHECK(outDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&loopClient)));
  CHECK(loopClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200000, 0, outFormat, nullptr));
  IAudioCaptureClient* loopCapture = nullptr;
  CHECK(loopClient->GetService(IID_PPV_ARGS(&loopCapture)));

  Recording cardRec, loopRec;
  cardRec.start(fmt.rate);
  loopRec.start(fmt.rate);

  std::thread loopThread([&] {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    loopClient->Start();
    while (running) {
      Sleep(2);
      UINT32 packet = 0;
      while (SUCCEEDED(loopCapture->GetNextPacketSize(&packet)) && packet) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        UINT64 qpc = 0;
        if (FAILED(loopCapture->GetBuffer(&data, &frames, &flags, nullptr, &qpc))) break;
        if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) loopRec.discontinuities += 1;
        loopRec.push(reinterpret_cast<float*>(data), frames, fmt.channels, qpc, flags & AUDCLNT_BUFFERFLAGS_SILENT);
        loopCapture->ReleaseBuffer(frames);
      }
    }
    loopClient->Stop();
  });

  // Passagem: um só thread atende a placa e a saída, com prioridade de áudio.
  Ring ring;
  ring.init(fmt.rate, fmt.channels);  // 1 s de folga; o controle mantém bem menos
  long long underruns = 0, drops = 0, droppedFrames = 0;
  long long capturedFrames = 0, renderedFrames = 0, renderErrors = 0;
  size_t maxFill = 0;
  std::vector<double> fillSamples;
  std::thread passThread([&] {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DWORD taskIndex = 0;
    HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
    // A saída começa com um período de silêncio, como pede o WASAPI.
    BYTE* buffer = nullptr;
    render->GetBuffer(outPeriod, &buffer);
    render->ReleaseBuffer(outPeriod, AUDCLNT_BUFFERFLAGS_SILENT);
    in->Start();
    out->Start();
    // Alvo: um pacote da placa mais um período da saída, o mínimo que não falha.
    size_t capturePacket = 0;
    std::vector<float> converted;
    bool primed = false;
    HANDLE events[2] = {inEvent, outEvent};
    while (running) {
      DWORD which = WaitForMultipleObjects(2, events, FALSE, 100);
      // Lê tudo o que a placa tiver.
      UINT32 packet = 0;
      while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        UINT64 qpc = 0;
        if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, &qpc))) break;
        bool silent = flags & AUDCLNT_BUFFERFLAGS_SILENT;
        UINT32 rawFrames = frames;
        if (convert) {
          // Placa a 96 kHz: média de cada par de amostras (filtro simples antes de reduzir).
          const float* src = reinterpret_cast<float*>(data);
          int ratio = cardRate / fmt.rate;
          UINT32 outFrames = frames / ratio;
          converted.resize(static_cast<size_t>(outFrames) * fmt.channels);
          for (UINT32 i = 0; i < outFrames; i += 1) {
            for (int c = 0; c < fmt.channels; c += 1) {
              int sc = std::min(c, cardChannels - 1);
              float v = 0;
              for (int k = 0; k < ratio; k += 1) v += silent ? 0.0f : src[(i * ratio + k) * cardChannels + sc];
              converted[static_cast<size_t>(i) * fmt.channels + c] = v / ratio;
            }
          }
          data = reinterpret_cast<BYTE*>(converted.data());
          frames = outFrames;
          silent = false;
        }
        if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) cardRec.discontinuities += 1;
        cardRec.push(reinterpret_cast<float*>(data), frames, fmt.channels, qpc, silent);
        if (play) {
          if (silent) {
            std::vector<float> zeros(static_cast<size_t>(frames) * fmt.channels, 0.0f);
            ring.write(zeros.data(), frames);
          } else {
            ring.write(reinterpret_cast<float*>(data), frames);
          }
        }
        capturePacket = std::max<size_t>(capturePacket, frames);
        capturedFrames += frames;
        capture->ReleaseBuffer(rawFrames);
      }
      if (!play) continue;
      // Escreve na saída o que couber, sem completar com silêncio: silêncio
      // escrito viraria atraso fixo.
      UINT32 padding = 0;
      if (FAILED(out->GetCurrentPadding(&padding))) continue;
      size_t target = capturePacket + outPeriod;
      if (!primed) {
        if (ring.size < target) continue;
        primed = true;
      }
      if (padding == 0 && which == WAIT_OBJECT_0 + 1) underruns += 1;
      // Sobra além do alvo (relógios diferentes, travada): descarta a parte mais antiga.
      size_t limit = target + capturePacket;
      if (ring.size + padding > limit) {
        size_t excess = ring.size + padding - target;
        excess = std::min(excess, ring.size);
        ring.drop(excess);
        drops += 1;
        droppedFrames += static_cast<long long>(excess);
      }
      UINT32 room = outBufferFrames - padding;
      UINT32 frames = static_cast<UINT32>(std::min<size_t>(room, ring.size));
      if (frames) {
        HRESULT hr = render->GetBuffer(frames, &buffer);
        if (SUCCEEDED(hr)) {
          ring.read(reinterpret_cast<float*>(buffer), frames);
          render->ReleaseBuffer(frames, 0);
          renderedFrames += frames;
        } else {
          renderErrors += 1;
        }
      }
      maxFill = std::max(maxFill, ring.size + padding);
      if (which == WAIT_OBJECT_0 + 1) fillSamples.push_back((ring.size + padding) * 1000.0 / fmt.rate);
    }
    in->Stop();
    out->Stop();
    if (task) AvRevertMmThreadCharacteristics(task);
  });

  std::printf("%s por %.0f s...\n", play ? "tocando a placa" : "só medindo", seconds);
  Sleep(static_cast<DWORD>(seconds * 1000));
  running = false;
  passThread.join();
  loopThread.join();

  if (play) {
    double avg = 0;
    for (double v : fillSamples) avg += v;
    if (!fillSamples.empty()) avg /= fillSamples.size();
    std::printf("fila + buffer da saída: média %.2f ms, máximo %.2f ms; saída vazia %lld vezes; descartes %lld (%.1f ms)\n",
                avg, maxFill * 1000.0 / fmt.rate, underruns, drops, droppedFrames * 1000.0 / fmt.rate);
  }
  std::printf("quadros: capturados %lld, tocados %lld, erros na saída %lld\n", capturedFrames, renderedFrames,
              renderErrors);
  std::printf("descontinuidades: placa %d, loopback %d\n", cardRec.discontinuities, loopRec.discontinuities);
  correlate(cardRec, loopRec, 2.0);

  CoTaskMemFree(outFormat);
  CoTaskMemFree(cardMix);
  release(capture);
  release(render);
  release(loopCapture);
  release(in);
  release(out);
  release(loopClient);
  release(cardDevice);
  release(outDevice);
  release(enumerator);
  CoUninitialize();
  return 0;
}
