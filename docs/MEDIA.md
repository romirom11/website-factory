# Медіа-генерація

Production-контракт медіа реалізований у `src/media/**`. Фабрика не викликає
pay-per-use API для зображень або відео й не залежить від браузерних мостів.

## Інваріанти

- Згенеровані зображення є лише декоративними: фон, текстура, патерн або
  Open Graph image. Вони не можуть підміняти реальні фото бізнесу, приміщення
  чи робіт.
- Hero-відео будується тільки з реального evidence-фото бізнесу.
- `registerGeneratedAsset()` завжди записує `ai_generated=true` та
  `rights='private_demo_only'`; ці прапорці не передаються викликачем.
- Відсутність необов'язкового декоративного медіа деградує презентацію, але не
  підміняється фейковим результатом і не зупиняє весь build.

## Production-шляхи

### Декоративне зображення

`generateImage()` запускає Codex CLI з доступом через ChatGPT-підписку та
вимагає `image_gen/gpt-image-2`. Перед запуском модуль видаляє з дочірнього
environment `OPENAI_API_KEY` і `ANTHROPIC_API_KEY`, тому випадковий перехід на
платний API неможливий.

Адаптер приймає лише реальний image-файл, створений у поточному запуску. Якщо
Codex спробував намалювати результат через PIL, matplotlib або SVG і не створив
image_gen-артефакт, результат відхиляється з `ImageGenerationError`.

### Hero media

`planHeroMedia()` застосовує такий порядок:

1. Найновіший вручну завантажений `hero_clip` asset.
2. Детермінований MP4 через `generateHeroClip()`/`kenBurnsClip()`: ffmpeg робить
   Ken Burns рух поверх реального evidence-фото.
3. `fallbackHeroMedia()`: CSS/GSAP Ken Burns поверх того самого фото, якщо
   ffmpeg недоступний. Для `prefers-reduced-motion` залишається статичний кадр.

Другий шлях має source `ken_burns` і generator `ken-burns`. Це штатний
production renderer. Третій шлях не створює нового медіа,
тому не позначається як AI-generated.

## Публічний API

```ts
import {
  generateImage,
  generateHeroClip,
  fallbackHeroMedia,
  ffmpegAvailable,
  kenBurnsClip,
  registerGeneratedAsset,
} from '../src/media/index.js';
```

| Функція | Контракт |
|---|---|
| `generateImage(options)` | Декоративний image через Codex CLI; повертає `GeneratedImage` або кидає типізований `ImageGenerationError`. |
| `generateHeroClip(options)` | MP4 Ken Burns із реального фото; повертає `HeroClip` або `null`, коли ffmpeg недоступний. |
| `kenBurnsClip(options)` | Низькорівневий детермінований ffmpeg-renderer. |
| `fallbackHeroMedia(options)` | Конфіг browser-анімації без створення відеофайлу. |
| `ffmpegAvailable()` | Безпечна health-перевірка налаштованого ffmpeg binary. |
| `registerGeneratedAsset(...)` | Ідемпотентна реєстрація за `(businessId, sha256)` з незмінними safety-прапорцями. |

Підтримані asset kinds: `background`, `pattern`, `og`, `texture`, `decor`,
`hero_clip`.

## Конфігурація

| Змінна | Default | Призначення |
|---|---:|---|
| `CODEX_BIN` | `codex` | Codex CLI; на runner потрібен `codex login`. |
| `GEN_IMAGE_TIMEOUT_SECONDS` | `300` | Timeout однієї генерації зображення. |
| `HERO_CLIP_DURATION_SECONDS` | `8` | Тривалість MP4 Ken Burns. |
| `FFMPEG_BIN` | `ffmpeg` | Binary локального renderer-а. |
| `MEDIA_GEN_IMAGES` | `true` | Дозволяє необов'язкову декоративну генерацію під час build prep. |

Змінних `FLOWKIT_*` у production-контракті немає.

## Перевірка

```bash
# Чисті адаптери, без БД. Вихід: storage/media-verify/
pnpm tsx scripts/verify-media.ts

# Не запускати підпискову генерацію зображення, перевірити ffmpeg і fallback
pnpm tsx scripts/verify-media.ts --no-image

# Статичні контракти медіа та build pipeline
pnpm test:build-policy
pnpm test:brand
pnpm typecheck
```

Перед production rollout повний контракт запускається централізовано:

```bash
pnpm release:gate
```

## Схема БД

`assets` зберігає `ai_generated`, `generator` і `generation_meta`. Для
hero-кліпу metadata включає prompt, `sourceImagePath` і duration; це дозволяє
оператору простежити артефакт до реального evidence-фото.
