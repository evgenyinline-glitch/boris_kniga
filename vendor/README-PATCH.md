# vendor/page-flip.browser.js

Библиотека **StPageFlip** v2.0.7 (UMD-сборка, глобальный объект `window.St.PageFlip`),
скачана с jsDelivr: https://cdn.jsdelivr.net/npm/page-flip@2.0.7/dist/js/page-flip.browser.js

## Внесённые правки (патчи)

В файл внесены четыре правки — первые три исправляют известные ошибки апстрима,
из-за которых книга «зависала» при переходах в конец издания, четвёртая —
перелистывание «назад» в портретном (мобильном) режиме:

1. **`PageCollection.showNext()`** — проверка границы была неверной
   (`currentSpreadIndex < length` вместо `< length - 1`), из-за чего на
   последнем развороте индекс уходил за пределы массива и метод
   `showSpread()` падал с `TypeError: Cannot read properties of undefined (reading 'length')`.

2. **`PageCollection.showSpread()`** — добавлена защита `if (!t) return;`
   на случай выхода индекса за границы.

3. **`AbstractRender.start()`** — тело цикла `requestAnimationFrame` обёрнуто
   в `try/catch`: раньше одна ошибка рендера обрывала цикл навсегда,
   и страницы переставали обновляться («замёрзшая» книга). Ошибка
   выводится в консоль один раз (`[StPageFlip] render error:`).

4. **`FlipController.flipNext()` / `flipPrev()`** — точка старта задаётся
   в координатах блока книги: `x = rect.left + …`, `y = rect.top + …`.
   Апстрим передавал `flipPrev()` «сырой» `x: 10` и `y: 1` без смещения
   `rect.left/top`. В портретном режиме `rect.left = -pageWidth`, поэтому
   `isPointOnCorners()` возвращал `false`, и при `disableFlipByClick: true`
   переворот назад молча не выполнялся — на телефоне страницы «назад»
   не листались (кнопка ‹ и клик по левому краю).

Если файл будет перескачан заново — патчи нужно применить снова.

Исходная версия: page-flip@2.0.7, лицензия MIT.
