// Mede só o lado da saída: escreve um pulso no WASAPI e procura o pulso no loopback.
// Atraso = QPC do pulso no loopback - (QPC da escrita + quadros já na fila da saída).
//
// Uso: pulse.exe [--raw] [--jogo]
//   --raw   pede ao Windows para pular os efeitos (APOs) só neste stream.
//   --jogo  marca o stream como som de jogo (AudioCategory_GameMedia).

#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <thread>
#include <string>
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

static long long qpcNow100ns() {
  LARGE_INTEGER now, freq;
  QueryPerformanceCounter(&now);
  QueryPerformanceFrequency(&freq);
  return static_cast<long long>(now.QuadPart * 10000000.0 / freq.QuadPart);
}

int main(int argc, char** argv) {
  bool raw = false, game = false;
  for (int i = 1; i < argc; i += 1) {
    if (std::string(argv[i]) == "--raw") raw = true;
    if (std::string(argv[i]) == "--jogo") game = true;
  }
  CHECK(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
  IMMDeviceEnumerator* enumerator = nullptr;
  CHECK(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)));
  IMMDevice* outDevice = nullptr;
  CHECK(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &outDevice));

  IAudioClient3* out = nullptr;
  CHECK(outDevice->Activate(__uuidof(IAudioClient3), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&out)));
  WAVEFORMATEX* fmt = nullptr;
  CHECK(out->GetMixFormat(&fmt));
  const int rate = fmt->nSamplesPerSec, channels = fmt->nChannels;
  if (raw || game) {
    AudioClientProperties props = {};
    props.cbSize = sizeof(props);
    props.eCategory = game ? AudioCategory_GameMedia : AudioCategory_Other;
    props.Options = raw ? AUDCLNT_STREAMOPTIONS_RAW : AUDCLNT_STREAMOPTIONS_NONE;
    HRESULT hr = out->SetClientProperties(&props);
    std::printf("propriedades do stream (raw=%d, jogo=%d): 0x%08lX\n", raw, game, hr);
  }
  UINT32 def = 0, fund = 0, minP = 0, maxP = 0;
  CHECK(out->GetSharedModeEnginePeriod(fmt, &def, &fund, &minP, &maxP));
  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  CHECK(out->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, minP, fmt, nullptr));
  CHECK(out->SetEventHandle(event));
  UINT32 bufferFrames = 0;
  out->GetBufferSize(&bufferFrames);
  IAudioRenderClient* render = nullptr;
  CHECK(out->GetService(IID_PPV_ARGS(&render)));

  IAudioClient* loop = nullptr;
  CHECK(outDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&loop)));
  CHECK(loop->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 200000, 0, fmt, nullptr));
  IAudioCaptureClient* loopCapture = nullptr;
  CHECK(loop->GetService(IID_PPV_ARGS(&loopCapture)));

  std::atomic<bool> running{true};
  std::mutex lock;
  std::vector<long long> expected;  // QPC previsto de cada pulso
  // Loopback inteiro (mono, 48 kHz) com o QPC do primeiro quadro, para achar os picos depois.
  std::vector<float> loopSamples;
  long long loopStart = -1;

  std::thread loopThread([&] {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    loop->Start();
    while (running) {
      Sleep(1);
      UINT32 packet = 0;
      while (SUCCEEDED(loopCapture->GetNextPacketSize(&packet)) && packet) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        UINT64 qpc = 0;
        if (FAILED(loopCapture->GetBuffer(&data, &frames, &flags, nullptr, &qpc))) break;
        auto samples = reinterpret_cast<float*>(data);
        std::lock_guard<std::mutex> g(lock);
        if (loopStart < 0) loopStart = static_cast<long long>(qpc);
        for (UINT32 f = 0; f < frames; f += 1)
          loopSamples.push_back((flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.0f : samples[f * channels]);
        loopCapture->ReleaseBuffer(frames);
      }
    }
    loop->Stop();
  });

  DWORD taskIndex = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  out->Start();
  const int pulseFrames = 48;
  long long nextPulse = qpcNow100ns() + 5000000;  // primeiro pulso em 0,5 s
  int pulses = 0;
  int pulseLeft = 0;
  while (pulses < 10 || pulseLeft > 0) {
    WaitForSingleObject(event, 100);
    UINT32 padding = 0;
    out->GetCurrentPadding(&padding);
    UINT32 room = bufferFrames - padding;
    if (!room) continue;
    BYTE* buffer = nullptr;
    if (FAILED(render->GetBuffer(room, &buffer))) continue;
    auto samples = reinterpret_cast<float*>(buffer);
    long long now = qpcNow100ns();
    for (UINT32 f = 0; f < room; f += 1) {
      if (pulseLeft == 0 && now >= nextPulse && pulses < 10 && f == 0) {
        pulseLeft = pulseFrames;
        // Este quadro toca depois de tudo o que já está na fila.
        std::lock_guard<std::mutex> g(lock);
        expected.push_back(now + static_cast<long long>(padding) * 10000000LL / rate);
        pulses += 1;
        nextPulse = now + 5000000;
      }
      float v = pulseLeft > 0 ? 0.95f : 0.0f;
      if (pulseLeft > 0) pulseLeft -= 1;
      for (int c = 0; c < channels; c += 1) samples[f * channels + c] = v;
    }
    render->ReleaseBuffer(room, 0);
  }
  Sleep(600);
  running = false;
  loopThread.join();
  out->Stop();
  if (task) AvRevertMmThreadCharacteristics(task);

  std::printf("saída: %d Hz, período %u quadros, buffer %u quadros\n", rate, minP, bufferFrames);
  std::printf("pulso escrito -> pico no loopback (ms):");
  for (long long e : expected) {
    long long from = (e - loopStart) * rate / 10000000LL;
    long long to = from + rate * 4 / 10;  // janela de 400 ms
    if (from < 0 || to > static_cast<long long>(loopSamples.size())) {
      std::printf(" ?");
      continue;
    }
    long long best = from;
    for (long long i = from; i < to; i += 1)
      if (std::fabs(loopSamples[i]) > std::fabs(loopSamples[best])) best = i;
    std::printf(" %.1f(%.2f)", (best - from) * 1000.0 / rate, std::fabs(loopSamples[best]));
  }
  std::printf("\n");
  return 0;
}
