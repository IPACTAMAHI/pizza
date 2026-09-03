/* ================================================================
   DATA LAYER — единственный источник правды: recipes.json на GitHub
   ================================================================
   Раньше здесь лежала константа SEED_RECIPES — слепок базы, зашитый
   прямо в код. Она убрана намеренно. Слепок неизбежно устаревал, и
   любая ситуация, когда сайт не смог прочитать recipes.json, приводила
   к тому, что в памяти оказывался старый список; стоило после этого
   что-нибудь сохранить — и на сервер уезжала устаревшая копия, стирая
   рецепты, добавленные позже. Теперь при отсутствии данных список
   остаётся ПУСТЫМ: пустота видна сразу и безобидна, а молчаливая
   подмена свежих данных старыми — нет.
   Локальная копия в localStorage остаётся, но только как кэш для
   быстрого показа и работы без сети; настоящие данные всегда
   подтягиваются из recipes.json (см. syncFromGithub).
   ================================================================ */

const STORAGE_KEY = 'pizza_recipes_v3';
let recipes = [];

/* Было ли на этом устройстве что-то в локальном кэше на момент запуска.
   Нужно для canPublishRecipes: если кэш непустой, значит сайт уже
   работал с данными, и публиковать эту копию поверх сервера можно
   только когда мы точно прочитали сервер. */
var hadLocalRecipesAtStart = false;

function loadRecipes() {
  try {
    var stored = localStorage.getItem(STORAGE_KEY);
    var parsed = stored ? JSON.parse(stored) : null;
    recipes = Array.isArray(parsed) ? parsed : [];
  }
  catch(e) { recipes = []; console.error('Load error:', e); }
  hadLocalRecipesAtStart = recipes.length > 0;
}

/* Можно ли публиковать текущий список рецептов на GitHub.
   Нельзя, если актуальную версию с сервера получить не удалось: в
   памяти тогда лежит локальная (а у нового посетителя — вообще зашитая
   в файл) копия, и публикация стёрла бы всё, чего в ней нет. Это ровно
   тот случай, когда «сохранил один рецепт — пропали остальные». */
function canPublishRecipes() {
  if (dataSource === 'github') return true;   // сервер прочитан, поверх писать безопасно
  // 'missing' — сервер ответил 404. Это либо действительно новый сайт
  // (файла ещё нет), либо копия на GitHub Pages временно отстала от
  // репозитория. Различить их по одному ответу нельзя, поэтому
  // публикуем только когда терять нечего: на устройстве не было своей
  // копии, то есть список заведомо начат с нуля.
  if (dataSource === 'missing') return !hadLocalRecipesAtStart;
  return false;
}

function saveAll() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes));
    if (isAdmin()) {
      if (canPublishRecipes()) {
        syncToGithub(false); // фоновая синхронизация, тихо (без тоста при успехе)
      } else {
        showToast('⚠️ Не удалось получить актуальный список с GitHub — изменение сохранено только на этом устройстве. Обновите страницу и повторите.');
      }
    }
    return true;
  } catch(e) {
    if (e.name === 'QuotaExceededError') {
      showToast('⚠️ Хранилище переполнено! Удалите старые рецепты или уменьшите фото.');
    } else {
      showToast('⚠️ Ошибка сохранения: ' + e.message);
    }
    console.error('Save error:', e);
    return false;
  }
}

/* ================================================================
   СТАТУС РЕЦЕПТА (актуальность)
   ================================================================
   Рецепт никуда не исчезает, когда блюдо снимают с меню или когда
   заканчивается сезон: карточка остаётся, но её перестают видеть
   обычные сотрудники. Так технологическая карта не теряется — её
   можно вернуть одним нажатием, когда блюдо снова понадобится.

   Статус хранится в поле r.status. У всех рецептов, созданных до
   появления статусов, поля нет — они считаются актуальными
   (см. recipeStatus), поэтому миграция данных не нужна.
   ================================================================ */
var RECIPE_STATUSES = [
  { id: 'active',   icon: '✅', label: 'Актуально',               short: 'Актуально', color: '#2f7d4f' },
  { id: 'off-menu', icon: '🚫', label: 'Убрано с меню',           short: 'Убрано',    color: '#8a5a1f' },
  { id: 'seasonal', icon: '❄️', label: 'Не актуально (сезонное)', short: 'Сезонное',  color: '#3a5f8a' }
];

function recipeStatus(r) {
  var s = r && r.status;
  for (var i = 0; i < RECIPE_STATUSES.length; i++) {
    if (RECIPE_STATUSES[i].id === s) return s;
  }
  return 'active'; // нет поля или значение незнакомое — считаем актуальным
}

function statusMeta(id) {
  for (var i = 0; i < RECIPE_STATUSES.length; i++) {
    if (RECIPE_STATUSES[i].id === id) return RECIPE_STATUSES[i];
  }
  return RECIPE_STATUSES[0];
}

/* Кому какой рецепт показывать. Обычный сотрудник видит только то, что
   реально готовится сейчас; админ и разработчик — всё, иначе они не
   смогли бы вернуть блюдо в меню. */
function canSeeAllRecipeStatuses() {
  return isAdmin(); // isAdmin() истинен и для разработчика
}

function isRecipeVisibleForViewer(r) {
  return canSeeAllRecipeStatuses() || recipeStatus(r) === 'active';
}

function uid() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

/* ================================================================
   TOAST
   ================================================================ */
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ================================================================
   MODAL — замена window.prompt()/window.confirm()
   ================================================================
   На iOS, когда сайт открыт как значок "На экран Домой" (standalone
   режим, без адресной строки Safari), браузер МОЛЧА блокирует
   prompt() и confirm() — код выполняется, но диалог просто не
   появляется. Поэтому здесь свой HTML-диалог, который работает
   одинаково в обычной вкладке и в standalone-режиме.
   ================================================================ */
/* Специальное значение, которым resolve()-ится showModal(), когда гость
   на экране "Как вас зовут?" нажимает ссылку "Я разработчик — войти".
   Отличимо от любого введённого имени (обычная строка), поэтому вызывающий
   код (ensureParticipantName) может однозначно распознать этот случай. */
var DEV_LOGIN_SENTINEL = { __devLoginRequested: true };

/* Аналогичный спец.значение для ссылки "Уже заходили с другого
   браузера? Ввести код" на том же экране знакомства — см.
   promptEnterAccessCode() и ensureParticipantName(). */
var CODE_ENTRY_SENTINEL = { __codeEntryRequested: true };

/* Экраны ожидания/блокировки (showPendingScreen, showBlockedScreen) делают
   document.body.innerHTML = '...' и тем самым удаляют модалку (#app-modal-overlay
   и всё внутри неё) из DOM вместе со всем остальным содержимым body — после
   этого $('app-modal-title') и т.п. возвращают null, и showModal() падает
   с "Cannot set properties of null" при клике на "Я разработчик — войти".
   Поэтому перед использованием модалки всегда проверяем, что она на месте,
   и, если нет, восстанавливаем её разметку в body. */
function ensureModalDom() {
  if ($('app-modal-overlay')) return;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="photo-lightbox" id="photo-lightbox" onclick="closePhotoLightbox()">' +
      '<img id="photo-lightbox-img" src="" alt="">' +
    '</div>' +
    '<div class="modal-overlay" id="app-modal-overlay">' +
      '<div class="modal-box">' +
        '<h3 id="app-modal-title"></h3>' +
        '<p id="app-modal-message"></p>' +
        '<input type="text" id="app-modal-input" style="display:none" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">' +
        '<select id="app-modal-select" style="display:none"></select>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost btn-sm" id="app-modal-cancel">Отмена</button>' +
          '<button class="btn btn-primary btn-sm" id="app-modal-ok">ОК</button>' +
        '</div>' +
        '<div id="app-modal-dev-login-wrap" style="display:none;text-align:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--glass-border)">' +
          '<span id="app-modal-dev-login" style="color:var(--text-muted);font-size:12px;text-decoration:underline;cursor:pointer">🔑 Я разработчик (владелец) — войти</span>' +
        '</div>' +
        '<div id="app-modal-code-entry-wrap" style="display:none;text-align:center;margin-top:10px">' +
          '<span id="app-modal-code-entry" style="color:var(--text-muted);font-size:12px;text-decoration:underline;cursor:pointer">🔗 Уже заходили с другого браузера? Ввести код</span>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

/* Контейнер для списка галочек (withChecklist — см. showModal). Создаётся
   на лету, а не задан в index.html: разметку модалки в разное время
   собирают три места (index.html, ensureModalDom и восстановление после
   showPendingScreen/showBlockedScreen, которые затирают body), и любое из
   них может оказаться старой версией без этого блока. Поэтому просто
   дописываем его перед кнопками, если его ещё нет. */
function ensureModalChecklistDom() {
  if ($('app-modal-checklist')) return;
  var overlay = $('app-modal-overlay');
  if (!overlay) return;
  var actions = overlay.querySelector('.modal-actions');
  if (!actions) return;
  actions.insertAdjacentHTML('beforebegin', '<div class="modal-checklist" id="app-modal-checklist" style="display:none"></div>');
}

/* Подвал модалки — блок ПОД кнопками действия (footerHtml в showModal).
   Нужен для второстепенных действий вроде «Нет ключа? Написать
   администратору»: если положить такую кнопку в текст сообщения, она
   окажется ВЫШЕ поля ввода и будет спорить за внимание с главной
   кнопкой («Войти»). Создаётся на лету по тем же соображениям, что и
   список галочек выше. */
/* ================================================================
   ВЫБОР ЗНАЧКА (эмодзи) ДЛЯ ВКЛАДКИ, КАТЕГОРИИ ИЛИ ЗАВЕДЕНИЯ
   ================================================================
   Раньше значок вводили руками — с телефона это означало лезть в
   клавиатуру эмодзи и искать там нужный, а с компьютера чаще всего
   копировать откуда-то. Теперь открывается список: сверху —
   рекомендованные под конкретный случай (для вкладки одни, для
   категории блюд другие), ниже — общий набор. Своё значение вписать
   по-прежнему можно: поле ввода остаётся над списком.
   ================================================================ */
const EMOJI_SUGGESTED = {
  section: ['🍕', '🔥', '❄️', '🥐', '🍰', '🥤', '🍳', '🥘', '🧑‍🍳', '🍔', '🥗', '🍜', '📦', '🧊'],
  category: ['🍕', '🍝', '🍞', '🥐', '🍰', '🧁', '🍪', '🥗', '🍲', '🍜', '🥪', '🌮', '🍔', '🍟', '🥤', '☕'],
  venue: ['🏠', '🏡', '🏢', '🏬', '🍕', '🥖', '☕', '🍽️', '🏪', '⭐', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣']
};

/* Общий набор — то, что чаще всего нужно кухне и залу. Список
   намеренно ограничен: полный каталог эмодзи здесь только мешал бы. */
const EMOJI_LIBRARY = [
  { group: 'Блюда', items: ['🍕', '🍔', '🌭', '🥪', '🌮', '🌯', '🥙', '🧆', '🍝', '🍜', '🍲', '🥘', '🍛', '🍚', '🍣', '🍤', '🥟', '🍗', '🥩', '🥓', '🍳', '🥚', '🧀', '🥗', '🥣', '🍿'] },
  { group: 'Выпечка и десерты', items: ['🍞', '🥖', '🥐', '🥨', '🥯', '🧇', '🥞', '🍰', '🎂', '🧁', '🍪', '🍩', '🍫', '🍬', '🍮', '🍯', '🍦', '🥧'] },
  { group: 'Продукты', items: ['🥔', '🥕', '🌽', '🍅', '🥒', '🥬', '🥦', '🧄', '🧅', '🍄', '🌶️', '🫒', '🍋', '🍊', '🍎', '🍓', '🍇', '🍌', '🥑', '🐟', '🦐', '🥛', '🧂', '🫙'] },
  { group: 'Напитки', items: ['🥤', '☕', '🍵', '🧃', '🧋', '🍺', '🍷', '🥂', '🧉', '🧊', '💧'] },
  { group: 'Цех и работа', items: ['🔥', '❄️', '🧑‍🍳', '👨‍🍳', '🍳', '🔪', '🥄', '🍽️', '⚖️', '⏰', '🧰', '🧯', '🧼', '🧊', '📦', '🚚', '🏭', '🏪', '🏠', '🏢'] },
  { group: 'Метки', items: ['📁', '🗂️', '🏷️', '⭐', '✅', '❤️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🆕', '🔝'] }
];

/* Набор полей в одном окне. Раньше несколько значений спрашивались
   подряд, по одному окну на каждое: телефон → почта → сайт. Это
   раздражало (три подтверждения ради одной карточки) и мешало
   исправлять — увидев опечатку в телефоне, приходилось проходить всю
   цепочку заново. Теперь все поля показываются сразу. */
function ensureModalFieldsDom() {
  if ($('app-modal-fields')) return;
  var input = $('app-modal-input');
  if (!input) return;
  input.insertAdjacentHTML('afterend', '<div class="modal-fields" id="app-modal-fields" style="display:none"></div>');
}

function ensureModalEmojiDom() {
  if ($('app-modal-emoji')) return;
  var overlay = $('app-modal-overlay');
  if (!overlay) return;
  var actions = overlay.querySelector('.modal-actions');
  if (!actions) return;
  actions.insertAdjacentHTML('beforebegin', '<div class="modal-emoji" id="app-modal-emoji" style="display:none"></div>');
}

function emojiGridHtml(kind, currentValue) {
  var suggested = EMOJI_SUGGESTED[kind] || EMOJI_SUGGESTED.section;
  function grid(items) {
    return '<div class="emoji-grid">' + items.map(function(e) {
      return '<button type="button" class="emoji-btn' + (e === currentValue ? ' is-current' : '') +
        '" data-emoji="' + escAttr(e) + '" title="' + escAttr(e) + '">' + e + '</button>';
    }).join('') + '</div>';
  }
  // Один значок показываем в окне ровно один раз: он может встречаться
  // и в рекомендованных, и сразу в двух общих группах (🧊 — и напитки, и
  // цех), а повтор в списке выглядит как ошибка.
  var seen = suggested.slice();
  var html = '<div class="emoji-group-title">Рекомендуемые</div>' + grid(suggested);
  EMOJI_LIBRARY.forEach(function(g) {
    var items = g.items.filter(function(e) {
      if (seen.indexOf(e) !== -1) return false;
      seen.push(e);
      return true;
    });
    if (!items.length) return;
    html += '<div class="emoji-group-title">' + esc(g.group) + '</div>' + grid(items);
  });
  return html;
}

/* Спрашивает значок. Возвращает выбранный эмодзи, введённый вручную
   текст, '' (без значка) или null, если нажали «Отмена». */
async function pickEmoji(kind, currentValue, title) {
  var res = await showModal({
    title: title || 'Выберите значок',
    message: 'Нажмите на подходящий значок — или впишите свой в поле ниже и нажмите «Готово». Оставьте поле пустым, чтобы обойтись без значка.',
    withInput: true,
    inputValue: currentValue || '',
    placeholder: 'свой значок',
    withEmoji: kind,
    emojiValue: currentValue || '',
    okText: 'Готово'
  });
  if (res === null) return null;
  return (typeof res === 'string') ? res.trim() : '';
}

function ensureModalFooterDom() {
  if ($('app-modal-footer')) return;
  var overlay = $('app-modal-overlay');
  if (!overlay) return;
  var actions = overlay.querySelector('.modal-actions');
  if (!actions) return;
  actions.insertAdjacentHTML('afterend', '<div class="modal-footer-slot" id="app-modal-footer" style="display:none"></div>');
}

function showModal(opts) {
  ensureModalDom();
  ensureModalChecklistDom();
  ensureModalFieldsDom();
  ensureModalEmojiDom();
  ensureModalFooterDom();
  return new Promise(function(resolve) {
    var overlay = $('app-modal-overlay');
    var titleEl = $('app-modal-title');
    var msgEl = $('app-modal-message');
    var inputEl = $('app-modal-input');
    var selectEl = $('app-modal-select');
    var okBtn = $('app-modal-ok');
    var cancelBtn = $('app-modal-cancel');
    var devWrap = $('app-modal-dev-login-wrap');
    var devLink = $('app-modal-dev-login');
    var codeWrap = $('app-modal-code-entry-wrap');
    var codeLink = $('app-modal-code-entry');
    var checklistEl = $('app-modal-checklist');
    var fieldsEl = $('app-modal-fields');
    var footerEl = $('app-modal-footer');

    titleEl.textContent = opts.title || '';
    if (opts.messageHtml) {
      // esc() сохраняет переносы строк (white-space:pre-line на .modal-box p),
      // а messageHtml (уже готовый безопасный HTML — см. copyChipHtml/buildNameCodeCopyHtml,
      // значения экранированы через escAttr/esc) добавляется следом.
      msgEl.innerHTML = esc(opts.message || '') + opts.messageHtml;
    } else {
      msgEl.textContent = opts.message || '';
    }
    okBtn.textContent = opts.okText || 'ОК';
    cancelBtn.textContent = opts.cancelText || 'Отмена';
    cancelBtn.style.display = opts.hideCancel ? 'none' : '';

    if (opts.withInput) {
      inputEl.style.display = '';
      inputEl.type = opts.inputType || 'text';
      inputEl.value = opts.inputValue || '';
      inputEl.placeholder = opts.placeholder || '';
    } else {
      inputEl.style.display = 'none';
      inputEl.type = 'text';
    }

    if (selectEl) {
      if (opts.withSelect && opts.selectOptions && opts.selectOptions.length) {
        selectEl.style.display = '';
        selectEl.innerHTML = opts.selectOptions.map(function(o) {
          return '<option value="' + escAttr(o.value) + '"' + (o.value === opts.selectValue ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('');
      } else {
        selectEl.style.display = 'none';
        selectEl.innerHTML = '';
      }
    }

    // Список галочек — несколько значений можно выбрать за один раз
    // (используется окном «Роли» участника: роли выдаются пачкой).
    if (checklistEl) {
      if (opts.withChecklist && opts.withChecklist.length) {
        checklistEl.style.display = '';
        checklistEl.innerHTML = opts.withChecklist.map(function(o) {
          return '<label class="modal-check-row' + (o.disabled ? ' is-disabled' : '') + '">' +
            '<input type="checkbox" value="' + escAttr(o.value) + '"' + (o.checked ? ' checked' : '') + (o.disabled ? ' disabled' : '') + '>' +
            '<span class="modal-check-text">' +
              '<span class="modal-check-label">' + esc(o.label) + '</span>' +
              (o.hint ? '<span class="modal-check-hint">' + esc(o.hint) + '</span>' : '') +
            '</span>' +
          '</label>';
        }).join('');
      } else {
        checklistEl.style.display = 'none';
        checklistEl.innerHTML = '';
      }
    }

    // Несколько полей сразу: opts.withFields = [{key, label, value,
    // placeholder, inputType}]. Возвращается объект {key: значение}.
    if (fieldsEl) {
      if (opts.withFields && opts.withFields.length) {
        fieldsEl.style.display = '';
        fieldsEl.innerHTML = opts.withFields.map(function(f) {
          return '<label class="modal-field">' +
            '<span class="modal-field-label">' + esc(f.label) + '</span>' +
            '<input type="' + escAttr(f.inputType || 'text') + '" data-field-key="' + escAttr(f.key) + '"' +
              ' value="' + escAttr(f.value || '') + '"' +
              ' placeholder="' + escAttr(f.placeholder || '') + '"' +
              ' autocapitalize="off" autocorrect="off" spellcheck="false">' +
            (f.hint ? '<span class="modal-field-hint">' + esc(f.hint) + '</span>' : '') +
          '</label>';
        }).join('');
      } else {
        fieldsEl.style.display = 'none';
        fieldsEl.innerHTML = '';
      }
    }

    // Сетка эмодзи. Нажатие сразу закрывает окно с выбранным значком:
    // выбор значка — законченное действие, подтверждать его отдельной
    // кнопкой было бы лишним шагом.
    var emojiEl = $('app-modal-emoji');
    if (emojiEl) {
      if (opts.withEmoji) {
        emojiEl.style.display = '';
        emojiEl.innerHTML = emojiGridHtml(opts.withEmoji, opts.emojiValue);
        emojiEl.querySelectorAll('.emoji-btn').forEach(function(btn) {
          btn.onclick = function() { cleanup(btn.dataset.emoji); };
        });
      } else {
        emojiEl.style.display = 'none';
        emojiEl.innerHTML = '';
      }
    }

    if (footerEl) {
      footerEl.innerHTML = opts.footerHtml || '';
      footerEl.style.display = opts.footerHtml ? '' : 'none';
    }

    if (devWrap) devWrap.style.display = opts.devLogin ? '' : 'none';
    if (codeWrap) codeWrap.style.display = opts.enterCode ? '' : 'none';

    // Обязательное поле: пока не введено осмысленное значение, кнопка
    // подтверждения неактивна. Раньше окно на пустой ввод просто
    // открывалось заново, и это выглядело как «кнопка не работает».
    var minLen = opts.requireInput ? (opts.minInputLength || 1) : 0;
    function syncRequired() {
      if (!minLen) return;
      var ok = inputEl.value.trim().length >= minLen;
      okBtn.disabled = !ok;
      okBtn.classList.toggle('is-disabled', !ok);
    }
    inputEl.oninput = syncRequired;
    syncRequired();

    overlay.classList.add('show');
    if (opts.withInput) setTimeout(function() { inputEl.focus(); }, 60);
    else if (opts.withFields && opts.withFields.length) setTimeout(function() {
      var first = fieldsEl.querySelector('input');
      if (first) first.focus();
    }, 60);

    function cleanup(result) {
      overlay.classList.remove('show');
      okBtn.disabled = false;
      okBtn.classList.remove('is-disabled');
      inputEl.oninput = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      inputEl.onkeydown = null;
      if (devLink) devLink.onclick = null;
      if (codeLink) codeLink.onclick = null;
      resolve(result);
    }

    okBtn.onclick = function() {
      if (minLen && inputEl.value.trim().length < minLen) return; // защита на случай нажатия с клавиатуры
      if (opts.withChecklist) {
        // Отключённые галочки (например «Администратор» у обычного админа)
        // тоже попадают в результат, если они отмечены, — иначе сохранение
        // молча снимало бы роль, которую этому человеку не разрешено менять.
        var picked = [];
        checklistEl.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
          if (cb.checked) picked.push(cb.value);
        });
        cleanup(picked);
      }
      else if (opts.withFields) {
        var values = {};
        fieldsEl.querySelectorAll('input[data-field-key]').forEach(function(inp) {
          values[inp.dataset.fieldKey] = inp.value.trim();
        });
        cleanup(values);
      }
      else if (opts.withSelect) cleanup(selectEl.value);
      else cleanup(opts.withInput ? inputEl.value : true);
    };
    cancelBtn.onclick = function() {
      cleanup((opts.withInput || opts.withSelect || opts.withChecklist || opts.withFields) ? null : false);
    };
    inputEl.onkeydown = function(e) {
      if (e.key === 'Enter') { e.preventDefault(); okBtn.onclick(); }
    };
    if (devLink) {
      devLink.onclick = function() {
        cleanup(DEV_LOGIN_SENTINEL);
      };
    }
    if (codeLink) {
      codeLink.onclick = function() {
        cleanup(CODE_ENTRY_SENTINEL);
      };
    }
  });
}

function customPrompt(message, defaultValue, title, inputType) {
  return showModal({ title: title || 'Введите значение', message: message, withInput: true, inputValue: defaultValue || '', inputType: inputType || 'text' });
}

function customConfirm(message, title) {
  return showModal({ title: title || 'Подтверждение', message: message, withInput: false });
}

/* Модалка-выпадающий список: возвращает выбранное value или null, если
   нажали "Отмена". Используется, например, чтобы привязать поставщика
   к конкретному цеху (Пицца бар / Горячий цех / без привязки). */
function customSelect(message, options, selectedValue, title) {
  return showModal({ title: title || 'Выберите значение', message: message, withSelect: true, selectOptions: options, selectValue: selectedValue || '' });
}

/* ================================================================
   УЧАСТНИКИ — КТО ПОЛЬЗУЕТСЯ САЙТОМ ПО ССЫЛКЕ / QR

   Ссылка/QR общие на всех — персональных ссылок нет. Вместо этого
   доступ теперь "по одобрению" (allowlist), а не "по умолчанию открыт,
   потом можно закрыть":
   1) при первом визите браузер генерирует себе "код устройства" и
      просит представиться (не пароль, просто имя для администратора);
      если у администратора настроен Telegram — гостя ещё попросят
      одним нажатием отправить это имя и код администратору;
   2) дальше гость видит "Ожидайте подтверждения администратора" —
      сайт для него ещё не открыт;
   3) администратор вручную добавляет пару "имя + код" в админ-панели —
      это единственный способ передать запись в общий список (обычный
      посетитель не имеет прав на запись в GitHub, только администратор) —
      и это же действие является одобрением: как только запись появилась
      в списке, экран ожидания сам, без участия гостя, обновляется и
      открывает доступ (проверка идёт каждые 10 секунд);
   4) список хранится в participants.json рядом с recipes.json — читают
      его все (чтобы проверить свой статус), а изменяют только вы, через
      уже настроенный GitHub-токен.

   ВАЖНО (честно, без иллюзий): это не защита от копирования контента
   после того как доступ уже открыт, и не помешает передать ссылку
   человеку с одобренным устройством. Это способ решать, КОМУ открыть
   доступ, видеть, кто пользуется сайтом, и в любой момент закрыть
   доступ конкретному человеку.
   ================================================================ */
/* Значок Telegram (бумажный самолётик) — используется на кнопках
   «Написать администратору» на экранах доступа и в карточке "Поделиться"
   у рецепта. Размер и цвет задаёт .btn-telegram svg в styles.css. */
var TELEGRAM_ICON_SVG = '<svg viewBox="0 0 24 24"><path d="M21.9 4.3 18.8 19.8c-.2 1-.9 1.3-1.7.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.7 13.1l-4.8-1.5c-1-.3-1-1 .2-1.5L20.6 3c.9-.3 1.6.2 1.3 1.3z"></path></svg>';

const DEVICE_ID_KEY = 'r20_device_id';
const DEVICE_NAME_KEY = 'r20_device_name';
const PARTICIPANTS_KEY = 'r20_participants_cache';
const PARTICIPANTS_PATH = 'participants.json';
const MANUAL_CODE_KEY = 'r20_manual_code';
const KEY_FAIL_STATE_KEY = 'r20_key_fail_state';

var participants = [];

/* Ключ устройства ("код") по умолчанию выводится из отпечатка
   браузера — один и тот же браузер/профиль всегда даёт один и тот
   же код, сколько угодно раз ни очищай localStorage и в скольки бы
   инкогнито-вкладках его ни открывали. Это решает проблему повторных
   заявок в рамках ОДНОГО браузера.

   ЧЕСТНО, без иллюзий: одинакового кода в РАЗНЫХ браузерах (Chrome,
   Firefox, Edge, Safari) на одном и том же устройстве отпечаток НЕ
   даёт и в принципе не может — это не баг, а особенность веб-
   платформы: у каждого браузера свой движок рендеринга (canvas,
   шрифты, userAgent), а приватный режим ряда браузеров (Firefox,
   Safari, Brave) намеренно рандомизирует эти значения на каждый
   заход именно для того, чтобы сайты не могли распознавать
   пользователя — обойти это с сайта невозможно.

   Поэтому для "одного человека в любом браузере" здесь есть
   РУЧНОЙ перенос кода: пользователь копирует код в одном браузере
   (см. buildNameCodeCopyHtml) и вставляет его в другом через
   promptEnterAccessCode(). Тогда оба браузера привязываются к одной
   и той же записи участника, и блокировка (бан) этой записи
   действует во всех браузерах, куда код был перенесён. Ручной код
   имеет приоритет над автоматическим отпечатком.

   Важно для 100% бана: если устройство уже определено как
   заблокированное, promptEnterAccessCode() отказывает в смене кода
   ещё до открытия формы ввода (см. проверку внутри неё) — иначе
   забаненный человек мог бы вписать произвольный код и попытаться
   выдать себя за нового гостя. */
function getDeviceId() {
  var manual = localStorage.getItem(MANUAL_CODE_KEY);
  if (manual) return manual;

  var derived = deriveDeviceIdFromFingerprint();
  if (derived) {
    if (localStorage.getItem(DEVICE_ID_KEY) !== derived) {
      localStorage.setItem(DEVICE_ID_KEY, derived);
    }
    return derived;
  }
  // Фолбэк на случай, если отпечаток недоступен (например canvas
  // заблокирован расширением) — тогда остаётся старое поведение:
  // код на этот браузер, сохранённый в localStorage.
  var id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/* Нормализует введённый пользователем код к виду XXXX-XXXX (как он
   и выводится на экране), чтобы не сработать из-за лишних пробелов
   или маленьких букв при копипасте. Если после чистки код не похож
   на валидный (нет хотя бы 4+4 буквенно-цифровых символов), вернёт
   null — тогда promptEnterAccessCode() покажет ошибку и не сохранит
   его, чтобы не подменить рабочий код мусором. */
function normalizeEnteredCode(raw) {
  if (!raw) return null;
  // код в интерфейсе может содержать и суффикс "·отпечаток" (см.
  // getCombinedAccessCode) — для привязки нужен только сам код
  // устройства, часть до "·".
  var justCode = String(raw).split('·')[0];
  var cleaned = justCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length < 8) return null;
  cleaned = cleaned.slice(0, 8);
  return cleaned.slice(0, 4) + '-' + cleaned.slice(4, 8);
}

/* Запрашивает у пользователя код, полученный в другом браузере, и
   привязывает текущий браузер к нему (см. комментарий у getDeviceId).
   После сохранения перезагружает страницу — дальше вся логика
   (checkParticipantStatus, getMyParticipantRecord) естественно
   подхватит статус той записи участника, к которой относится код. */
async function promptEnterAccessCode() {
  // Защита от обхода бана: если это устройство уже определено как
  // заблокированное (по отпечатку или по текущему id — ДО какой-либо
  // ручной подмены кода), не даём вообще открыть ввод нового кода.
  // Иначе забаненный человек мог бы вписать произвольный, никому не
  // принадлежащий код и попытаться выдать себя за нового гостя.
  await syncParticipantsFromGithub();
  var current = getMyParticipantRecord();
  if (current && current.blocked) {
    await customConfirm('Доступ для этого устройства закрыт администратором. Смена кода недоступна, пока действует блокировка.', '🔒 Доступ закрыт');
    return;
  }

  var entered = await showModal({
    title: '🔗 Код с другого браузера',
    message: 'Вставьте код устройства, который вы уже видели при заходе в другом браузере (там, где доступ открыт). Формат: XXXX-XXXX.',
    withInput: true,
    placeholder: 'XXXX-XXXX',
    okText: 'Привязать'
  });
  if (!entered) return; // отмена
  var normalized = normalizeEnteredCode(entered);
  if (!normalized) {
    await customConfirm('Похоже, это не код устройства. Скопируйте его целиком с экрана другого браузера и попробуйте снова.', 'Не удалось распознать код');
    return;
  }
  localStorage.setItem(MANUAL_CODE_KEY, normalized);
  localStorage.setItem(DEVICE_ID_KEY, normalized); // для совместимости со старыми проверками
  location.reload();
}

function deriveDeviceIdFromFingerprint() {
  var fp = getDeviceFingerprint();
  if (!fp) return '';
  var padded = ('00000000' + fp).slice(-8).toUpperCase();
  return padded.slice(0, 4) + '-' + padded.slice(4, 8);
}

/* ================================================================
   "ОТПЕЧАТОК" УСТРОЙСТВА — доп. подпись браузера (рендер canvas,
   экран, часовой пояс, число ядер и т.п.), которая остаётся ТОЙ ЖЕ
   даже если очистить localStorage или открыть сайт в приватной/
   инкогнито-вкладке — то есть даже переход в другую вкладку не
   создаёт "нового человека" для системы блокировки.
   Честно: это не железная защита — на другом браузере или на
   устройстве с антифингерпринт-настройками отпечаток будет другим.
   Но от обычной попытки "зайти по-новой" через инкогнито защищает.
   ================================================================ */
function getDeviceFingerprint() {
  try {
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 80, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('r20-fp', 2, 2);
    var raw = [
      navigator.userAgent || '',
      navigator.language || '',
      screen.width + 'x' + screen.height + 'x' + screen.colorDepth,
      new Date().getTimezoneOffset(),
      navigator.hardwareConcurrency || '',
      canvas.toDataURL()
    ].join('||');
    var hash = 0;
    for (var i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0; }
    return (hash >>> 0).toString(16);
  } catch (e) {
    return '';
  }
}

function getCombinedAccessCode() {
  var fp = getDeviceFingerprint();
  return getDeviceId() + (fp ? ('·' + fp) : '');
}

function showDeviceCodeInFooter() {
  var el = $('device-code-footer');
  if (el) {
    el.innerHTML = 'Код устройства: ' + esc(getCombinedAccessCode()) +
      ' · <span onclick="promptEnterAccessCode()" style="text-decoration:underline;cursor:pointer">привязать другой браузер</span>';
  }
}

async function ensureParticipantName() {
  if (isAdmin()) return; // администратора эта система не касается — у него доступ через GitHub-ключ

  // Разработчик/владелец может войти прямо с этого экрана, минуя
  // представление именем — по ссылке "Я разработчик" ниже поля ввода.
  // Как только вход по ключу пройдёт успешно, isAdmin() станет true и
  // весь экран знакомства с сайтом (включая заявку в Telegram) пропускается.
  var name = localStorage.getItem(DEVICE_NAME_KEY);
  if (name) return; // уже представлялись раньше в этом браузере

  var warning = '';   // что сказать, если в прошлый раз ввели не то
  var typed = '';     // уже набранное — чтобы не заставлять печатать заново

  while (true) {
    var entered = await showModal({
      title: '👋 Добро пожаловать в Route 20',
      message: (warning ? warning + '\n\n' : '') +
        'Как вас зовут? Это не пароль — просто чтобы администратор видел, кто пользуется книгой рецептов, и мог управлять доступом. Без имени продолжить нельзя.',
      withInput: true,
      inputValue: typed,
      placeholder: 'Имя и фамилия',
      // Имя обязательно: администратор раздаёт доступ по именам, и
      // безымянная запись в списке участников бесполезна — непонятно,
      // кому её блокировать или продлевать.
      requireInput: true,
      minInputLength: 2,
      hideCancel: true,
      okText: 'Продолжить',
      devLogin: true
    });

    if (entered === DEV_LOGIN_SENTINEL) {
      var loggedIn = await loginWithGithubKey();
      if (loggedIn) return; // вошли как разработчик — экран знакомства больше не нужен
      continue; // ключ не ввели/не подошёл — снова показываем экран знакомства
    }

    var finalName = (entered || '').trim().replace(/\s+/g, ' ');
    typed = finalName;

    // Кнопка «Продолжить» и так неактивна при пустом поле, но проверку
    // дублируем: сюда можно попасть, например, нажав Enter.
    if (finalName.length < 2) {
      warning = '⚠️ Пожалуйста, укажите имя — хотя бы два символа.';
      continue;
    }
    // Имя из одних цифр или знаков администратору ничего не скажет.
    if (!/[\p{L}]/u.test(finalName)) {
      warning = '⚠️ Похоже, это не имя. Напишите, как вас зовут, буквами.';
      continue;
    }

    localStorage.setItem(DEVICE_NAME_KEY, finalName);
    await requireAccessKey(finalName); // просит ключ, выданный администратором, и сама привязывает к нему устройство
    return;
  }
}

/* ================================================================
   КЛЮЧ ДОСТУПА, ВЫДАННЫЙ АДМИНИСТРАТОРОМ

   Раньше единственным способом попасть в участники было: гость сам
   отправляет своё имя и автоматически посчитанный код устройства в
   Telegram, а администратор вручную копирует код из сообщения и
   добавляет его в список. У этого есть слабое место: код завязан на
   отпечаток браузера, поэтому в другом браузере/устройстве гость
   получает другой код и выглядит как новый человек.

   Теперь основной способ — наоборот: администратор ЗАРАНЕЕ создаёт
   ключ (кнопка "🔑 Сгенерировать ключ" в панели), сам передаёт его
   человеку любым способом (голосом, в Telegram и т.п.), а человек
   вводит этот ключ здесь при первом заходе. Ключ — это и есть
   постоянная личность человека в системе, не привязанная ни к
   браузеру, ни к устройству: с этим же ключом человек может зайти
   с любого браузера и увидит книгу рецептов сразу, без ожидания
   одобрения (оно уже "встроено" в сам факт, что администратор выдал
   ключ). Блокировка ключа администратором мгновенно закрывает доступ
   везде, где этот ключ используется — потому что личность определяется
   ключом, а не отпечатком конкретного браузера. */

/* ================================================================
   ЗАЩИТА ОТ ПОДБОРА КЛЮЧА
   ================================================================
   Ключ — 8 символов (XXXX-XXXX), но без ограничения на попытки его
   реально можно перебирать вручную раз за разом. Считаем только
   попытки с "ключ не найден" (именно они означают подбор, а не
   опечатку в уже правильном ключе) — после 5 подряд неудачных попыток
   ввод блокируется на 5 минут на этом устройстве, и вместо поля ввода
   показывается прямая ссылка "запросить ключ у администратора".
   Это не защита от того, кто чистит localStorage/меняет отпечаток —
   но останавливает обычный перебор в одном браузере и создаёт
   администратору понятный сигнал (см. также сообщение в заявке). */
function getKeyFailState() {
  try {
    var raw = localStorage.getItem(KEY_FAIL_STATE_KEY);
    var s = raw ? JSON.parse(raw) : null;
    return (s && typeof s.count === 'number') ? s : { count: 0, lockUntil: 0 };
  } catch (e) {
    return { count: 0, lockUntil: 0 };
  }
}

function saveKeyFailState(s) {
  try { localStorage.setItem(KEY_FAIL_STATE_KEY, JSON.stringify(s)); } catch (e) {}
}

var KEY_FAIL_LIMIT = 5;
var KEY_FAIL_LOCK_MS = 5 * 60 * 1000;

function registerFailedKeyAttempt() {
  var s = getKeyFailState();
  s.count = (s.count || 0) + 1;
  if (s.count >= KEY_FAIL_LIMIT) {
    s.lockUntil = Date.now() + KEY_FAIL_LOCK_MS;
    s.count = 0; // счётчик до следующей блокировки — заново
  }
  saveKeyFailState(s);
}

function clearKeyFailState() {
  saveKeyFailState({ count: 0, lockUntil: 0 });
}

function keyEntryLockedMsRemaining() {
  var s = getKeyFailState();
  var left = (s.lockUntil || 0) - Date.now();
  return left > 0 ? left : 0;
}

async function requireAccessKey(name) {
  while (true) {
    var lockedMs = keyEntryLockedMsRemaining();
    if (lockedMs > 0) {
      var lockedMin = Math.ceil(lockedMs / 60000);
      var requestHtml = '<div style="text-align:center">' +
        requestLinkHtml('keylocked', name, '📤 Запросить ключ у администратора', 'keylocked-request-btn') +
        '</div>';
      refreshRequestLinkHref(); // в фоне: вдруг администратор сменил Telegram, пока шли попытки
      await showModal({
        title: '⏳ Слишком много попыток',
        message: 'Ключ несколько раз подряд не подошёл — ввод временно недоступен (ещё ' + lockedMin + ' мин.) на этом устройстве. Если ключа нет — запросите его у администратора.',
        footerHtml: requestHtml,
        withInput: false,
        hideCancel: true,
        okText: 'Понятно',
        devLogin: true
      }).then(function(res) {
        if (res === DEV_LOGIN_SENTINEL) return loginWithGithubKey();
      });
      if (isAdmin()) return; // вошли как разработчик, пока ждали
      await new Promise(function(r) { setTimeout(r, 1000); }); // не даём мгновенно крутить цикл заново
      continue;
    }

    var contactHtml = '';
    var url = getTelegramSendUrl(name);
    if (url) {
      // Идёт в подвал окна (footerHtml) — ПОД кнопку «Войти»: это
      // запасной путь, он не должен перебивать главное действие.
      contactHtml = '<div style="text-align:center">' +
        '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Нет ключа?</div>' +
        '<a class="btn btn-telegram btn-sm" href="' + escAttr(url) + '" target="_blank" rel="noopener">' +
          TELEGRAM_ICON_SVG + (siteConfig.adminTelegramGroup ? 'Написать в группу' : 'Написать администратору') +
        '</a>' +
      '</div>';
    }

    var entered = await showModal({
      title: '🔑 Ключ доступа',
      message: 'Введите ключ доступа, который вам передал администратор книги рецептов. Без него открыть рецепты нельзя.',
      footerHtml: contactHtml,
      withInput: true,
      placeholder: 'XXXX-XXXX',
      hideCancel: true,
      okText: 'Войти',
      devLogin: true
    });

    if (entered === DEV_LOGIN_SENTINEL) {
      var loggedIn = await loginWithGithubKey();
      if (loggedIn) return; // вошли как разработчик
      continue;
    }

    var normalized = normalizeEnteredCode(entered);
    if (!normalized) {
      await customConfirm('Ключ не распознан. Проверьте, что скопировали его целиком (формат XXXX-XXXX), и попробуйте снова.', '⚠️ Неверный формат');
      continue;
    }

    // Ключ проверяем ПО АВТОРИТЕТНОМУ ИСТОЧНИКУ — напрямую по GitHub API.
    // Копия, которую раздаёт GitHub Pages, отстаёт до минуты, и опираться
    // на неё здесь нельзя сразу по двум причинам:
    //   • только что созданный ключ в ней ещё не появился — человек видел
    //     «ключ не найден» и ждал минуту;
    //   • только что удалённый участник в ней ещё ЕСТЬ — и, введя свой
    //     старый ключ, он вернул бы себе доступ, который у него забрали.
    // Если API недоступен (нет сети, исчерпан лимит), откатываемся на
    // копию с Pages — это лучше, чем не пустить человека вообще.
    var fresh = await fetchParticipantsFromGithubApi();
    if (fresh) {
      participants = fresh;
      saveParticipantsLocal();
    } else {
      await syncParticipantsFromGithub();
    }
    var p = participants.filter(function(x) { return x.id === normalized; })[0];

    // Отозванный ключ отвергаем отдельно от «не найден»: этот отказ
    // работает даже по устаревшей копии, потому что написан в самих
    // данных, а не выводится из их отсутствия.
    if (p && isRevokedRecord(p)) {
      registerFailedKeyAttempt();
      await customConfirm('Этот ключ отозван администратором и больше не действует. Если доступ нужен — попросите новый ключ.', '🔒 Ключ отозван');
      continue;
    }

    if (!p) {
      registerFailedKeyAttempt();
      await customConfirm('Такой ключ не найден. Проверьте, что ввели его без ошибок и целиком (формат XXXX-XXXX). Если не поможет — получите новый ключ у администратора.', '⚠️ Ключ не найден');
      continue;
    }

    clearKeyFailState();

    // Ключ найден — привязываем к нему это устройство независимо от
    // статуса (в том числе если он уже занят другим браузером того же
    // человека, или уже заблокирован — дальше это как обычно проверит
    // checkParticipantStatus/showBlockedScreen).
    localStorage.setItem(MANUAL_CODE_KEY, normalized);
    localStorage.setItem(DEVICE_ID_KEY, normalized);

    if (!p.claimed) {
      // Первое использование этого ключа — окончательно привязываем
      // его к человеку: имя, отпечаток (информационно, для админ-панели).
      p.name = name;
      p.fingerprint = getDeviceFingerprint() || p.fingerprint || '';
      p.claimed = true;
      p.claimedAt = Date.now();
      saveParticipantsLocal();
      // ВАЖНО: у обычного участника (не администратора) нет GitHub-токена —
      // он никогда не хранится в его браузере, только у администратора
      // (см. loginWithGithubKey/openGithubSettings). Поэтому запись сюда
      // почти всегда молча не удастся, а showToast с "настройте синхронизацию"
      // только пугала бы гостя, у которого и так всё работает. Пробуем
      // только если токен реально есть (например разработчик сам проверяет
      // свой же ключ), а окончательную фиксацию claimed:true в общем
      // participants.json на GitHub берёт на себя reconcileClaimedKeysFromPresence()
      // — как только администратор откроет вкладку "Админка", увидит это
      // устройство в списке "Онлайн" и сам, своим токеном, дозапишет статус.
      var cfg = getGithubConfig();
      if (cfg && cfg.token) {
        await syncParticipantsToGithub();
      }
    }
    // Перезагружаем страницу: getDeviceId()/Firebase-присутствие и все
    // остальные проверки должны сразу использовать НОВЫЙ id (сам ключ),
    // а не старый, посчитанный по отпечатку браузера до входа — иначе
    // администратор увидит "онлайн" по старому id, который ни с одной
    // записью участников не совпадает, и автосверка ниже не сработает.
    location.reload();
    return;
  }
}

function loadParticipantsLocal() {
  try {
    var raw = localStorage.getItem(PARTICIPANTS_KEY);
    participants = raw ? JSON.parse(raw) : [];
  } catch (e) { participants = []; }
}

function saveParticipantsLocal() {
  try { localStorage.setItem(PARTICIPANTS_KEY, JSON.stringify(participants)); } catch (e) {}
}

/* ================================================================
   ЗАДЕРЖКА GITHUB PAGES И СВЕЖИЙ СПИСОК УЧАСТНИКОВ
   ================================================================
   Обычное чтение идёт по относительному пути './participants.json' —
   то есть из копии, которую раздаёт GitHub Pages. Но Pages обновляет
   свою копию НЕ сразу после коммита: сайт пересобирается и
   раскатывается по CDN до минуты. Из-за этого только что созданный
   ключ доступа реально существовал в репозитории, но по «сайтовой»
   копии его ещё не было — и человек получал «Такой ключ не найден»,
   пока Pages не догонит.

   Само содержимое файла при этом доступно мгновенно через GitHub API
   (api.github.com/.../contents/...): он отдаёт данные прямо из
   репозитория, без промежуточной сборки. Репозиторий публичный, так
   что читать его можно вообще без токена — а значит и обычному гостю,
   у которого никакого ключа GitHub нет и быть не должно.

   Владельца и название репозитория берём (по очереди): из настроек
   синхронизации, если человек — администратор; из site-config.json,
   куда их записывает администратор при сохранении любых настроек;
   иначе выводим из адреса вида owner.github.io/repo. Это публичные
   данные, никакого секрета в них нет.
   ================================================================ */
function getPublicRepoRef() {
  var cfg = getGithubConfig();
  if (cfg && cfg.owner && cfg.repo) return { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch || 'main' };
  if (siteConfig && siteConfig.repoOwner && siteConfig.repoName) {
    return { owner: siteConfig.repoOwner, repo: siteConfig.repoName, branch: siteConfig.repoBranch || '' };
  }
  var m = /^([a-z0-9][a-z0-9-]*)\.github\.io$/.exec((location.hostname || '').toLowerCase());
  if (m) {
    var seg = (location.pathname || '/').split('/').filter(Boolean)[0];
    // Без явной ветки — GitHub API сам возьмёт ветку по умолчанию.
    return { owner: m[1], repo: seg || (m[1] + '.github.io'), branch: '' };
  }
  return null;
}

async function fetchParticipantsFromGithubApi() {
  var ref = getPublicRepoRef();
  if (!ref) return null;
  try {
    var url = 'https://api.github.com/repos/' + encodeURIComponent(ref.owner) + '/' + encodeURIComponent(ref.repo) +
      '/contents/' + PARTICIPANTS_PATH + '?_=' + Date.now() +
      (ref.branch ? '&ref=' + encodeURIComponent(ref.branch) : '');
    // Accept: ...raw — GitHub отдаёт сам файл, а не обёртку с base64.
    var headers = { 'Accept': 'application/vnd.github.raw' };
    var cfg = getGithubConfig();
    if (cfg && cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token; // у администратора выше лимит запросов
    var res = await fetchWithTimeout(url, { headers: headers, cache: 'no-store' }, 12000);
    if (!res.ok) return null;
    var data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (e) {
    console.warn('fetchParticipantsFromGithubApi:', e);
    return null;
  }
}

/* Обратная сторона той же задержки Pages: человек только что ввёл
   ключ, запись о нём сохранена локально, страница перезагрузилась —
   а «сайтовая» копия списка участников всё ещё старая, без него.
   Раньше она просто затирала локальную, запись пропадала, и человека
   выкидывало на экран «Ожидайте подтверждения администратора» —
   ровно на ту же минуту.

   Поэтому свою собственную, только что привязанную запись держим
   поверх пришедшего списка, пока Pages не догонит. Ограничение по
   времени принципиально: если администратор потом удалит или
   заблокирует человека, старая локальная запись уже не будет его
   «спасать» — по истечении этого окна побеждает то, что пришло с
   сервера. */
/* Окно намеренно короткое: столько занимает пересборка GitHub Pages.
   Раньше здесь было 30 минут, и это ЛОМАЛО удаление участника —
   администратор стирал запись, а браузер удалённого всё это время
   подставлял обратно свою локальную копию, и доступ не закрывался
   даже после десятка перезагрузок. Теперь окно — только на время
   задержки Pages, а любое сомнение разрешается запросом к
   авторитетному источнику (см. confirmAccessAgainstGithub). */
var RECENT_CLAIM_GRACE_MS = 2 * 60 * 1000;

/* Ставится, когда GitHub API — источник без задержки — подтвердил, что
   записи больше нет или она заблокирована. После этого локальная копия
   уже никогда не «воскрешает» доступ. */
var accessRevoked = false;

function keepRecentlyClaimedSelf(incoming) {
  try {
    if (accessRevoked) return incoming; // доступ отозван — держать нечего
    var myId = getDeviceId();
    if (!myId) return incoming;
    if (incoming.some(function(x) { return x.id === myId; })) return incoming; // сервер уже знает — берём серверную версию
    var mine = participants.filter(function(x) { return x.id === myId; })[0];
    if (!mine || !mine.claimedAt) return incoming;
    if (Date.now() - mine.claimedAt > RECENT_CLAIM_GRACE_MS) return incoming;
    return incoming.concat([mine]);
  } catch (e) {
    return incoming;
  }
}

/* ================================================================
   ФОНОВАЯ ПРОВЕРКА ДОСТУПА (каждые 15 секунд)
   ================================================================
   Раньше статус участника проверялся ровно один раз — при загрузке
   страницы. Поэтому «🚫 Блок» и «✕ Удалить» не действовали, пока
   человек сам не перезагрузит вкладку, а мгновенно срабатывала только
   кнопка «Выйти»: она идёт через Firebase, то есть по живому каналу.

   Теперь доступ переспрашивается в фоне. Проверка тихая: ничего не
   перерисовывает и не мешает работать — пока всё в порядке, человек
   вообще ничего не замечает.

   Важная тонкость: копия participants.json, которую раздаёт GitHub
   Pages, обновляется с задержкой до минуты. Поэтому «моей записи нет»
   само по себе НЕ повод закрывать доступ — иначе человека выкидывало
   бы через 15 секунд после того, как он только что вошёл по ключу.
   Прежде чем что-то предпринять, спрашиваем GitHub API — он отдаёт
   файл сразу после коммита и врать про задержку не может.
   ================================================================ */
var ACCESS_POLL_MS = 15000;
var accessPollTimer = null;
var accessCheckInFlight = false;

function startAccessPoll() {
  if (accessPollTimer || accessRevoked) return;
  accessPollTimer = setInterval(pollAccessStatus, ACCESS_POLL_MS);
  // Возвращаясь к вкладке, проверяем сразу — пока её не смотрели,
  // проверки не шли, и статус мог измениться.
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) pollAccessStatus();
  });
}

function stopAccessPoll() {
  clearInterval(accessPollTimer);
  accessPollTimer = null;
}

/* Переспрашивает авторитетный источник. Возвращает:
   'ok'      — доступ есть;
   'blocked' — запись заблокирована;
   'gone'    — записи нет;
   'unknown' — проверить не удалось (нет сети и т.п.) — трогать нельзя. */
async function confirmAccessAgainstGithub() {
  var fresh = await fetchParticipantsFromGithubApi();
  if (!fresh) return 'unknown';
  participants = fresh;              // без keepRecentlyClaimedSelf: здесь нужна голая правда
  saveParticipantsLocal();
  var me = getMyParticipantRecord();
  if (!me) return 'gone';
  return me.blocked ? 'blocked' : 'ok';
}

async function pollAccessStatus() {
  if (accessCheckInFlight || accessRevoked) return;
  if (isDeveloper()) return;         // владелец входит по GitHub-ключу, списком участников его не отзывают
  if (document.hidden) return;       // вкладка не на виду — не тратим сеть впустую
  accessCheckInFlight = true;
  try {
    // Смотрим копию с Pages именно в сыром виде: подставленная своя
    // запись (см. keepRecentlyClaimedSelf) здесь всё бы испортила —
    // проверка видела бы её и решала, что доступ на месте.
    var serverList = await fetchParticipantsFromPages();
    if (serverList) {
      var meOnServer = findMyRecordIn(serverList);
      if (meOnServer && !meOnServer.blocked) {
        participants = keepRecentlyClaimedSelf(serverList); // всё в порядке — просто обновляем кэш
        saveParticipantsLocal();
        return;                                             // самый частый случай, к API не ходим
      }
    }

    // Записи нет или она заблокирована — но копия с Pages отстаёт до
    // минуты, поэтому это ещё не приговор. Спрашиваем авторитетный
    // источник, и только он решает.
    var verdict = await confirmAccessAgainstGithub();
    if (verdict === 'ok' || verdict === 'unknown') return;

    accessRevoked = true;
    stopAccessPoll();
    if (verdict === 'blocked') showBlockedScreen();
    else forceReLogin();
  } catch (e) {
    console.warn('pollAccessStatus:', e);
  } finally {
    accessCheckInFlight = false;
  }
}

/* Запись удалили — уводим человека на экран входа ровно так же, как это
   делает кнопка «Выйти» (см. слушатель kicks/ в initFirebasePresence). */
function forceReLogin() {
  try {
    localStorage.removeItem(DEVICE_NAME_KEY);
    localStorage.removeItem(MANUAL_CODE_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
    localStorage.removeItem(ADMIN_KEY);
  } catch (e) {}
  location.reload();
}

/* Читает копию списка с GitHub Pages КАК ЕСТЬ, без подстановки своей
   локальной записи. Нужно там, где важна именно серверная правда, —
   прежде всего фоновой проверке доступа: если бы она смотрела на
   список после keepRecentlyClaimedSelf, то видела бы собственную
   подставленную запись и считала бы, что доступ на месте. */
async function fetchParticipantsFromPages() {
  try {
    var res = await fetch('./' + PARTICIPANTS_PATH + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    var data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (e) {
    return null;
  }
}

async function syncParticipantsFromGithub() {
  try {
    var res = await fetch('./' + PARTICIPANTS_PATH + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return; // файла ещё нет (никого не добавляли) или открыто локально — тихий фолбэк
    var data = await res.json();
    if (Array.isArray(data)) {
      participants = keepRecentlyClaimedSelf(data);
      saveParticipantsLocal();
      if (currentTab === 'admin') renderParticipantsList();
    }
  } catch (e) {
    console.warn('syncParticipantsFromGithub: используются локальные данные', e);
  }
}

/* Общая устойчивая запись JSON-файла в GitHub: с тайм-аутом на случай
   медленного интернета и автоматическим повтором один раз при
   конфликте версий (409) — той же проблемой, что чинили для
   recipes.json (см. doSyncToGithub). Используется для participants.json
   и site-config.json, чтобы не дублировать эту логику дважды. */
async function putJsonToGithub(path, dataObj, commitMessage, isRetry) {
  var cfg = getGithubConfig();
  if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) {
    return { ok: false, error: 'GitHub-синхронизация не настроена (⚙️ в разделе «Добавить»)' };
  }
  try {
    var apiUrl = 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + path;
    var headers = { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github+json' };

    var sha = null;
    // no-store + метка времени в URL — иначе браузер может отдать закэшированный
    // (устаревший) ответ на этот GET, и тогда даже повтор после 409 получит
    // тот же самый устаревший sha и снова упадёт с той же ошибкой.
    var getRes = await fetchWithTimeout(apiUrl + '?ref=' + encodeURIComponent(cfg.branch) + '&_=' + Date.now(), { headers: headers, cache: 'no-store' }, 20000);
    if (getRes.status === 200) {
      var getData = await getRes.json();
      sha = getData.sha;
    } else if (getRes.status === 401) {
      return { ok: false, error: 'Токен неверный или устарел (401). Обновите его в настройках синхронизации.' };
    } else if (getRes.status !== 404) {
      return { ok: false, error: 'Проверка файла: HTTP ' + getRes.status };
    }

    var body = { message: commitMessage, content: b64EncodeUnicode(JSON.stringify(dataObj, null, 2)), branch: cfg.branch };
    if (sha) body.sha = sha;

    var putRes = await fetchWithTimeout(apiUrl, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body)
    }, 20000);

    if (putRes.status === 409 && !isRetry) {
      return putJsonToGithub(path, dataObj, commitMessage, true); // кто-то успел записать первее — берём свежий sha и пробуем ещё раз
    }
    if (!putRes.ok) {
      var errData = await putRes.json().catch(function() { return {}; });
      return { ok: false, error: errData.message || ('HTTP ' + putRes.status) };
    }
    return { ok: true };
  } catch (e) {
    var msg = (e && e.name === 'AbortError') ? 'Истекло время ожидания — проверьте интернет и попробуйте ещё раз.' : (e.message || String(e));
    return { ok: false, error: msg };
  }
}

var ghWriteQueues = {}; // path -> цепочка промисов, чтобы параллельные записи одного файла не гонялись друг с другом
function queueGithubWrite(key, taskFn) {
  var chain = ghWriteQueues[key] || Promise.resolve();
  var run = chain.then(taskFn, taskFn);
  ghWriteQueues[key] = run.catch(function() {});
  return run;
}

function syncParticipantsToGithub() {
  return queueGithubWrite('participants', async function() {
    var cfg = getGithubConfig();
    if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) {
      showToast('⚠️ Сначала настройте синхронизацию с GitHub (⚙️ в разделе «Добавить»)');
      return false;
    }
    var res = await putJsonToGithub(PARTICIPANTS_PATH, participants, 'Обновление списка участников (' + new Date().toLocaleString('ru-RU') + ')');
    if (res.ok) { saveParticipantsLocal(); return true; }
    console.error('syncParticipantsToGithub error:', res.error);
    showToast('⚠️ Не удалось сохранить список участников: ' + res.error);
    return false;
  });
}

/* ================================================================
   "ОНЛАЙН" — все посетители сайта (не только участники)
   ================================================================
   Отдельная система от GitHub-хранилища выше: там пишет только
   администратор (у него один есть токен), а здесь должен уметь
   писать КАЖДЫЙ посетитель — "я тут" с меткой времени. Для этого
   используется Firebase Realtime Database (бесплатно): её правила
   доступа разрешают каждому браузеру писать ТОЛЬКО свою запись по
   своему коду устройства (presence/<код>) и не позволяют читать,
   менять или удалять чужие записи — то есть обычный посетитель не
   может увидеть или тронуть список других людей, это доступно
   только в самой админ-панели.

   Каждый браузер шлёт "я тут" сразу при заходе (ещё до того, как
   пройдена проверка ключа/одобрения — чтобы администратор видел
   вообще всех, кто заглянул на сайт, даже неодобренных), затем
   обновляет метку времени каждые ~25 секунд, пока вкладка открыта.
   Firebase сама отмечает "не в сети", как только соединение
   реально обрывается (закрыли вкладку, погас интернет) — это
   называется onDisconnect и работает на стороне сервера Firebase,
   а не браузера, поэтому срабатывает даже при обрыве связи.

   Блокировка человека из этого списка — это не что-то отдельное:
   она просто создаёт/обновляет ту же самую запись в participants.json
   (с blocked:true), которую использует вся остальная система доступа
   на сайте. Поэтому забаненный отсюда человек получит ровно тот же
   "Доступ закрыт", что и обычный заблокированный участник — независимо
   от того, состоял ли он раньше в списке участников.
   ================================================================ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCCSKyQ0s15zRI0RtgnE3ORNG60-ioZVtc",
  authDomain: "route20-online.firebaseapp.com",
  databaseURL: "https://route20-online-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "route20-online",
  storageBucket: "route20-online.firebasestorage.app",
  messagingSenderId: "864775899669",
  appId: "1:864775899669:web:1aa2c73280003a9b171c1c"
};

var fbPresenceRef = null;
var onlineUsers = {};          // код устройства -> { lastSeen, online, name, ua }
var onlineUsersFilter = 'all'; // 'all' | 'live' | 'members'
var onlineListenerAttached = false;
var presenceHeartbeatTimer = null;

function initFirebasePresence() {
  if (typeof firebase === 'undefined') return; // сеть/CDN недоступны — блок "Онлайн" просто останется пустым, на остальной сайт это не влияет
  try {
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    var db = firebase.database();
    var myId = getDeviceId();
    fbPresenceRef = db.ref('presence/' + myId);

    // Канонический рецепт presence для Realtime Database: как только
    // реально устанавливается соединение, регистрируем на СЕРВЕРЕ
    // действие "при обрыве связи — пометить не в сети", и только
    // после этого пишем "я в сети". Так это работает даже если
    // человек просто закрыл вкладку или отключился от интернета,
    // без единого действия с его стороны.
    db.ref('.info/connected').on('value', function(snap) {
      if (snap.val() !== true) return;
      fbPresenceRef.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP })
        .then(function() { sendPresenceUpdate(); });
    });

    // "Выйти" — кнопка "✕" в списке "Онлайн" пишет сюда метку времени,
    // это устройство слушает СВОЙ же путь и, увидев команду, сбрасывает
    // локальное представление (имя + вручную привязанный код) и
    // перезагружает страницу — человек снова увидит экран "Как вас
    // зовут?" и запрос ключа доступа. Сама запись участника/ключ при
    // этом не трогается: введя тот же ключ ещё раз, доступ вернётся
    // сразу, без повторного одобрения — это не блокировка, а просто
    // принудительный повторный вход.
    db.ref('kicks/' + myId).on('value', function(snap) {
      if (!snap.val()) return;
      db.ref('kicks/' + myId).remove().catch(function() {});
      // На отключение уже был запланирован "серверный" апдейт (см. выше) —
      // отменяем его и стираем свою запись сами, чтобы в списке "Онлайн"
      // не мелькнула запись "не в сети" в момент перед самой перезагрузкой.
      if (fbPresenceRef) {
        fbPresenceRef.onDisconnect().cancel().catch(function() {});
        fbPresenceRef.remove().catch(function() {});
      }
      localStorage.removeItem(DEVICE_NAME_KEY);
      localStorage.removeItem(MANUAL_CODE_KEY);
      // Сбрасываем и режим администратора: без этого "kick" ничего не давал
      // бы устройству, у которого флаг режима администратора был выставлен
      // вручную (в обход настоящего GitHub-ключа) — после перезагрузки оно
      // снова прошло бы мимо экрана входа. Реального администратора это не
      // обижает: рабочий ключ никуда не делся, войти обратно — секундное дело.
      localStorage.removeItem(ADMIN_KEY);
      location.reload();
    });

    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = setInterval(sendPresenceUpdate, 25000);
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') sendPresenceUpdate();
    });
  } catch (e) {
    console.warn('Firebase presence недоступен:', e);
  }
}

function sendPresenceUpdate() {
  if (!fbPresenceRef) return;
  var name = localStorage.getItem(DEVICE_NAME_KEY) || '';
  fbPresenceRef.update({
    online: true,
    lastSeen: firebase.database.ServerValue.TIMESTAMP,
    name: name,
    ua: (navigator.userAgent || '').slice(0, 140)
  }).catch(function(e) { console.warn('sendPresenceUpdate error:', e); });
}

/* Подписка на общий список "Онлайн" — включается, только пока открыта
   вкладка "Админ-панель" (чтобы не тратить впустую канал у всех
   остальных вкладок сайта), и отписывается при выходе с неё. */
function subscribeOnlineUsers() {
  if (typeof firebase === 'undefined' || onlineListenerAttached) return;
  try {
    firebase.database().ref('presence').on('value', function(snap) {
      onlineUsers = snap.val() || {};
      renderOnlineUsersList();
      if (currentTab === 'admin' && participantsFilter !== 'keys') renderParticipantsList(); // подтягиваем статус онлайн/офлайн в основном списке участников
      reconcileClaimedKeysFromPresence();
    });
    onlineListenerAttached = true;
  } catch (e) {
    console.warn('subscribeOnlineUsers error:', e);
  }
}

/* ================================================================
   АВТОСВЕРКА "НЕИСПОЛЬЗОВАННЫХ" КЛЮЧЕЙ, КОТОРЫЕ НА САМОМ ДЕЛЕ УЖЕ
   ИСПОЛЬЗОВАНЫ
   ================================================================
   Проблема: когда обычный гость (не администратор) вводит ключ
   доступа в requireAccessKey(), его браузер помечает участника как
   claimed:true ТОЛЬКО локально — записать это в общий participants.json
   на GitHub он не может, потому что GitHub-токен есть лишь в браузере
   администратора (см. loginWithGithubKey). Из-за этого в админ-панели
   ключ мог вечно висеть как "неиспользованный", даже если человек уже
   давно им пользуется.

   Решение использует то, что УЖЕ работает без токена — Firebase
   presence (см. initFirebasePresence): после входа по ключу id
   устройства в presence совпадает с самим ключом (id участника). Раз
   в presence "живёт" запись с этим id — значит ключ точно кем-то введён
   и используется, независимо от того, что написано в participants.json.

   Поэтому здесь, пока открыта вкладка "Админка" (только тогда и активен
   этот слушатель — см. subscribeOnlineUsers/unsubscribeOnlineUsers), при
   каждом обновлении списка "Онлайн" сверяем: если участник с таким id
   в наших данных всё ещё claimed:false — значит запись просто не успела
   дойти до GitHub, и мы, уже СВОИМ (администраторским) токеном,
   дозаписываем claimed:true. Гостю для этого ничего заново вводить не
   нужно — достаточно, что администратор хоть раз откроет админ-панель. */
function reconcileClaimedKeysFromPresence() {
  if (!isAdmin()) return;
  var changed = false;
  Object.keys(onlineUsers).forEach(function(id) {
    var entry = onlineUsers[id];
    var p = participants.filter(function(x) { return x.id === id; })[0];
    if (p && !isRevokedRecord(p) && p.claimed === false) {
      p.claimed = true;
      p.claimedAt = p.claimedAt || (entry && entry.lastSeen) || Date.now();
      if (!p.name && entry && entry.name) p.name = entry.name;
      changed = true;
    }
  });
  if (!changed) return;
  saveParticipantsLocal();
  if (currentTab === 'admin') renderParticipantsList();
  syncParticipantsToGithub(); // тихо, без лишних тостов об успехе — это фоновое исправление, а не действие администратора
}

function unsubscribeOnlineUsers() {
  if (typeof firebase === 'undefined' || !onlineListenerAttached) return;
  try { firebase.database().ref('presence').off(); } catch (e) {}
  onlineListenerAttached = false;
}

function setOnlineUsersFilter(f) {
  onlineUsersFilter = f;
  renderOnlineUsersList();
}

/* "В сети прямо сейчас" — не полагаемся только на флаг online (он
   может не успеть смениться на false, если Firebase ещё не заметил
   обрыв), а дополнительно проверяем, что метка времени свежее ~40
   секунд — это чуть больше периода "я тут" (25с), чтобы не мигало. */
function isOnlineLive(entry) {
  if (!entry || !entry.lastSeen) return false;
  return (Date.now() - entry.lastSeen) < 40000;
}

function formatTimeAgo(ts) {
  if (!ts) return 'неизвестно';
  var diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 15) return 'прямо сейчас';
  if (diffSec < 60) return diffSec + ' сек. назад';
  var diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return diffMin + ' мин. назад';
  var diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return diffHour + ' ч. назад';
  return new Date(ts).toLocaleString('ru-RU');
}

/* Раньше в списке "Онлайн" показывались ТОЛЬКО те, у кого уже есть
   одобренная запись в participants.json — то есть реально может
   смотреть книгу рецептов. Проблема: presence-пинг устройство шлёт
   ВСЕГДА, с самого открытия сайта, ещё до какого-либо одобрения (см.
   initFirebasePresence) — а значит скрытыми оказывались не только
   безобидные "застрявшие на экране входа" гости, но и любой, кто
   получил доступ к функциям сайта в обход обычной проверки (например
   вручную выставив флаг режима администратора в консоли браузера —
   см. verifyStoredAdminSession). Такой человек был не виден в списке
   и, соответственно, не блокируем из него.

   Теперь список показывает ВСЕХ, кто прямо сейчас шлёт presence —
   у тех, чьей записи в participants.json нет или кто заблокирован,
   рядом с именем стоит предупреждение "⚠️ нет доступа", а кнопка
   "🚫 Блок" по-прежнему работает (для незарегистрированных создаёт
   сразу заблокированную запись). */
function hasSiteAccess(participant) {
  return !!(participant && !participant.blocked);
}

function renderOnlineUsersList() {
  var holder = $('online-list');
  var filterRow = $('online-filter-row');
  var badge = $('online-count-badge');
  if (!holder) return;

  var ids = Object.keys(onlineUsers);
  var entries = ids.map(function(id) {
    var e = onlineUsers[id] || {};
    var participant = activeParticipants(participants).filter(function(p) { return p.id === id; })[0] || null;
    return {
      id: id,
      lastSeen: e.lastSeen || 0,
      name: e.name || (participant ? participant.name : '') || '',
      ua: e.ua || '',
      live: isOnlineLive(e),
      participant: participant,
      hasAccess: hasSiteAccess(participant)
    };
  });
  entries.sort(function(a, b) { return b.lastSeen - a.lastSeen; });

  var liveCount = entries.filter(function(x) { return x.live; }).length;
  if (badge) badge.textContent = entries.length ? (liveCount + ' сейчас · ' + entries.length + ' всего') : '';

  if (filterRow) {
    filterRow.innerHTML =
      '<button class="btn btn-sm ' + (onlineUsersFilter === 'all' ? 'btn-primary' : 'btn-ghost') + '" onclick="setOnlineUsersFilter(\'all\')">Все (' + entries.length + ')</button>' +
      '<button class="btn btn-sm ' + (onlineUsersFilter === 'live' ? 'btn-primary' : 'btn-ghost') + '" onclick="setOnlineUsersFilter(\'live\')">🟢 Сейчас на сайте (' + liveCount + ')</button>';
  }

  var shown = entries.filter(function(x) {
    if (onlineUsersFilter === 'live') return x.live;
    return true;
  });

  if (!shown.length) {
    holder.innerHTML = '<p class="admin-panel-hint">' + (entries.length ? 'Никого не найдено по этому фильтру.' : 'Пока никого с доступом не заходило — список появится, как только кто-то с одобренным доступом откроет сайт.') + '</p>';
    return;
  }

  holder.innerHTML = shown.map(function(x) {
    var roleBadge = participantHasRole(x.participant, 'admin') ? '<span class="online-member-badge">👑 админ</span>' : '';
    var accessBadge = !x.hasAccess ? '<span class="online-member-badge" style="background:var(--warning);color:#1a1a1a" title="Нет одобренной записи участника или заблокирован, но при этом реально на сайте — стоит проверить">⚠️ нет доступа</span>' : '';
    var itemClass = 'participant-item online-item' + (x.live ? ' is-live' : '') + (!x.hasAccess ? ' is-blocked' : '');
    return '<div class="' + itemClass + '">' +
      '<div>' +
        '<span class="online-dot"></span><strong>' + esc(x.name || 'Без имени') + '</strong>' + roleBadge + accessBadge +
        '<br><span style="font-size:12px;color:var(--text-muted)">' + esc(x.id) + ' · ' + (x.live ? '🟢 на сайте сейчас' : 'был(а) ' + formatTimeAgo(x.lastSeen)) + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button class="btn btn-sm btn-danger" onclick="toggleOnlineUserBlock(\'' + escAttr(x.id) + '\',\'' + escAttr(x.name || '') + '\')" title="Закрыть доступ этому устройству насовсем">🚫 Блок</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="removeOnlinePresence(\'' + escAttr(x.id) + '\')" title="Закрыть доступ насовсем и немедленно выкинуть на экран входа, если устройство сейчас на связи">✕ Выйти</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* Блокировка прямо из списка "Онлайн" — в этом списке показываются
   только те, у кого сейчас есть доступ (см. hasSiteAccess), поэтому
   кнопка всегда закрывает доступ существующему участнику. Ветка
   "участника ещё нет" оставлена как подстраховка на случай гонки
   (запись пропала из локального кэша между отрисовкой и нажатием). */
async function toggleOnlineUserBlock(id, name) {
  if (!can('participant.block')) { denyToast('participant.block'); return; }
  var p = participants.filter(function(x) { return x.id === id; })[0];

  if (p) {
    var willBlock = !p.blocked;
    var ok = await customConfirm(willBlock ? 'Закрыть доступ этому человеку?' : 'Вернуть доступ этому человеку?');
    if (!ok) return;
    p.blocked = willBlock;
  } else {
    var ok2 = await customConfirm('Заблокировать это устройство? Оно ещё не было одобрено — запись будет создана сразу заблокированной, и доступ на сайт этому устройству будет закрыт.');
    if (!ok2) return;
    participants.push({ id: id, fingerprint: '', name: name || '', addedAt: Date.now(), blocked: true, role: 'viewer', claimed: true });
  }

  saveParticipantsLocal();
  renderOnlineUsersList();
  if (currentTab === 'admin') renderParticipantsList();
  showToast('⏳ Сохраняю...');
  var saved = await syncParticipantsToGithub();
  if (saved) showToast(p && !p.blocked ? '🔓 Доступ открыт' : '🚫 Доступ закрыт');
  // при saved===false внутри syncParticipantsToGithub уже показан toast с точной причиной
}

/* "✕ Выйти" — закрывает доступ этому устройству НАСОВСЕМ (так же, как
   "🚫 Блок": participants.json получает/обновляет запись с
   blocked:true) И, если устройство сейчас на связи, немедленно
   выкидывает его на экран входа — не дожидаясь, пока оно само зайдёт
   на сайт в следующий раз. На той стороне при получении команды
   "kick" полностью сбрасывается локальное состояние браузера,
   включая флаг режима администратора (см. слушатель 'kicks/' + myId
   в initFirebasePresence) — это важно для случая, когда флаг был
   выставлен вручную (в обход настоящего GitHub-ключа): после сброса
   и перезагрузки такое устройство пройдёт verifyStoredAdminSession и
   ensureParticipantName заново, как обычный гость, и увидит "Доступ
   закрыт" благодаря только что выставленной блокировке. */
/* Отправляет устройству команду «выйти» по живому каналу Firebase — то
   же самое, что делает кнопка «✕ Выйти» в списке «Онлайн». Срабатывает
   мгновенно, если человек прямо сейчас на сайте. Если он офлайн —
   ничего страшного: доступ всё равно закроется, это подхватит фоновая
   проверка (pollAccessStatus) при следующем открытии сайта. */
function signalDeviceKick(id) {
  if (typeof firebase === 'undefined') return Promise.resolve();
  try {
    var db = firebase.database();
    return db.ref('kicks/' + id).set(firebase.database.ServerValue.TIMESTAMP)
      .then(function() { return db.ref('presence/' + id).remove().catch(function() {}); })
      .catch(function() {});
  } catch (e) {
    return Promise.resolve();
  }
}

async function removeOnlinePresence(id) {
  if (!can('participant.remove')) { denyToast('participant.remove'); return; }
  if (typeof firebase === 'undefined') { showToast('⚠️ Онлайн-список сейчас недоступен'); return; }
  var ok = await customConfirm('Закрыть доступ этому устройству насовсем и выкинуть его на экран входа прямо сейчас (если оно на связи)?');
  if (!ok) return;

  // Закрываем доступ так же, как кнопка "🚫 Блок" — блокируем
  // существующую запись участника или создаём новую сразу
  // заблокированной, если её раньше не было.
  var p = participants.filter(function(x) { return x.id === id; })[0];
  if (p) {
    p.blocked = true;
  } else {
    var entry = onlineUsers[id] || {};
    participants.push({ id: id, fingerprint: '', name: entry.name || '', addedAt: Date.now(), blocked: true, role: 'viewer', claimed: true });
  }
  saveParticipantsLocal();
  if (currentTab === 'admin') renderParticipantsList();

  // Как и раньше — убираем из списка "Онлайн" сразу, не дожидаясь
  // ответа сервера, чтобы UI реагировал мгновенно; если что-то пойдёт
  // не так, вернём запись обратно (см. catch ниже).
  var previousEntry = onlineUsers[id];
  delete onlineUsers[id];
  renderOnlineUsersList();

  try {
    var db = firebase.database();
    await db.ref('kicks/' + id).set(firebase.database.ServerValue.TIMESTAMP); // сработает, только если устройство сейчас на связи
    await db.ref('presence/' + id).remove();
    showToast('⏳ Сохраняю блокировку...');
    var saved = await syncParticipantsToGithub();
    if (saved) showToast('🚫 Доступ закрыт, команда на выход отправлена');
    // при saved===false внутри syncParticipantsToGithub уже показан toast с точной причиной
  } catch (e) {
    if (previousEntry) onlineUsers[id] = previousEntry; // не получилось — возвращаем запись обратно в список
    renderOnlineUsersList();
    showToast('⚠️ Не удалось выполнить: ' + (e.message || e));
  }
}

/* ================================================================
   НАСТРОЙКИ САЙТА (сейчас — только Telegram-юзернейм администратора)
   ================================================================
   Хранится в site-config.json рядом с recipes.json/participants.json —
   читают все (без авторизации), пишет только администратор (через
   уже настроенный GitHub-токен). Нужно, чтобы гость при первом входе
   мог одним нажатием отправить своё имя и код устройства администратору
   в Telegram, не спрашивая его лично.
   ================================================================ */
const SITE_CONFIG_KEY = 'r20_site_config_cache';
const SITE_CONFIG_PATH = 'site-config.json';

var SITE_CONFIG_DEFAULTS = {
  adminTelegram: '', adminTelegramGroup: '', customTabs: [], categories: [],
  // Публичные (не секретные) координаты репозитория — нужны гостю, чтобы
  // при вводе ключа прочитать participants.json напрямую через GitHub API,
  // минуя задержку GitHub Pages. См. getPublicRepoRef.
  repoOwner: '', repoName: '', repoBranch: ''
};
var siteConfig = Object.assign({}, SITE_CONFIG_DEFAULTS);

function loadSiteConfigLocal() {
  try {
    var raw = localStorage.getItem(SITE_CONFIG_KEY);
    if (raw) siteConfig = Object.assign({}, SITE_CONFIG_DEFAULTS, JSON.parse(raw));
  } catch (e) {}
}

function saveSiteConfigLocal() {
  try { localStorage.setItem(SITE_CONFIG_KEY, JSON.stringify(siteConfig)); } catch (e) {}
}

/* Всегда реально ходит в сеть за свежим site-config.json (не полагается
   на кэш) — вызывается перед КАЖДОЙ отправкой заявки в Telegram, чтобы,
   если администратор успел поменять юзернейм/ссылку на группу, гость
   отправлял сообщение уже по новым данным, а не по старым из localStorage. */
/* Откуда реально взяты настройки, показанные сейчас:
     'github'  — только что получены с сервера, можно смело публиковать
                 поверх (мы видим актуальную версию);
     'missing' — файла на сервере ещё нет, публиковать безопасно;
     'local'   — связаться с сервером НЕ удалось, показаны локальные
                 данные. Публиковать их поверх серверных нельзя: там
                 может лежать более свежая версия, и мы её затрём. */
var siteConfigSource = 'local';

async function syncSiteConfigFromGithub() {
  try {
    var res = await fetch('./' + SITE_CONFIG_PATH + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) {
      // 404 — файла ещё нет (настройки ни разу не сохраняли); прочие
      // коды означают проблему со связью, а не отсутствие файла.
      siteConfigSource = (res.status === 404) ? 'missing' : 'local';
      return false;
    }
    var data = await res.json();
    if (data && typeof data === 'object') {
      siteConfigSource = 'github';
      siteConfig = Object.assign({}, SITE_CONFIG_DEFAULTS, data);
      saveSiteConfigLocal();
      updateTelegramConfigField();
      renderSectionNavTabs();
      renderSectionsAdminList();
      renderCategoryChipRows();
      renderTypeSelect();
      refreshAllSectionLists();
      return true;
    }
    return false;
  } catch (e) {
    console.warn('syncSiteConfigFromGithub: используются локальные данные', e);
    return false;
  }
}

function syncSiteConfigToGithub() {
  return queueGithubWrite('site-config', async function() {
    var cfg = getGithubConfig();
    if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) {
      showToast('⚠️ Сначала настройте синхронизацию с GitHub (⚙️ в разделе «Добавить»)');
      return false;
    }
    // Заодно запоминаем в общедоступных настройках, из какого репозитория
    // живёт сайт. Это не ключ и не секрет (репозиторий и так публичный) —
    // но именно эти три строки позволяют гостю на любом домене прочитать
    // свежий participants.json через GitHub API при вводе ключа.
    if (cfg.owner && cfg.repo) {
      siteConfig.repoOwner = cfg.owner;
      siteConfig.repoName = cfg.repo;
      siteConfig.repoBranch = cfg.branch || 'main';
    }
    var res = await putJsonToGithub(SITE_CONFIG_PATH, siteConfig, 'Обновление настроек сайта (' + new Date().toLocaleString('ru-RU') + ')');
    if (res.ok) { saveSiteConfigLocal(); return true; }
    console.error('syncSiteConfigToGithub error:', res.error);
    showToast('⚠️ Не удалось сохранить настройки: ' + res.error);
    return false;
  });
}

function updateTelegramConfigField() {
  var input = $('admin-telegram-username');
  if (input && document.activeElement !== input) input.value = siteConfig.adminTelegram || '';
  var groupInput = $('admin-telegram-group');
  if (groupInput && document.activeElement !== groupInput) groupInput.value = siteConfig.adminTelegramGroup || '';
}

/* ================================================================
   РАЗДЕЛЫ САЙТА (вкладки верхней навигации)
   ================================================================
   Раньше устройство было такое: одна встроенная вкладка «Категории»
   со ВСЕМИ рецептами сразу, отдельная встроенная вкладка «Добавить
   рецепт» и поверх этого — «дополнительные вкладки», которые на
   самом деле показывали тот же самый общий список рецептов и те же
   самые общие категории. То есть книга была одна, пиццейная, а
   вкладки — просто разные окна в неё.

   Теперь каждая вкладка — самостоятельный РАЗДЕЛ со своей кухней:
     • свой набор категорий (у пиццерии — Пицца/Тесто/Соусы,
       у кондитера — Торты/Кремы, у горячего цеха — свои);
     • свой список рецептов (рецепт принадлежит ровно одному разделу);
     • своя кнопка «Добавить рецепт» прямо внутри вкладки;
     • своя роль доступа (tab:<id>) — как и раньше у вкладок.
   Разделы между собой ничем не связаны: рецепты и категории одного
   не видны и не мешают другому.

   Бывшая вкладка «Категории» стала обычным разделом с id 'main'
   (по умолчанию названным «Пицца бар») — её точно так же можно
   переименовать, удалить и выдать её роль, как любую другую.

   ХРАНЕНИЕ И СОВМЕСТИМОСТЬ СО СТАРЫМИ ДАННЫМИ.
   Разделы лежат в siteConfig.sections (файл site-config.json), туда
   же переезжает прежний список customTabs. У категорий появилось
   поле section, у рецептов — тоже. Старые записи этих полей не
   имеют, поэтому везде, где они читаются, отсутствующее значение
   означает «главный раздел» (см. categorySectionId/recipeSectionId).
   Благодаря этому сайт корректно работает ещё ДО того, как
   разработчик впервые сохранит перенос (см. migrateToSections).
   ================================================================ */
var MAIN_SECTION_ID = 'main';

function defaultSections() {
  return [{ id: MAIN_SECTION_ID, label: 'Пицца бар', icon: '🍕' }];
}

/* ================================================================
   ЗАВЕДЕНИЯ (точки сети)
   ================================================================
   Сайт обслуживает не одну пиццерию, а сеть. Каждое заведение ведёт
   свои разделы, свои категории, свои рецепты и свою закупку; код при
   этом один на всех, поэтому новая возможность появляется сразу во
   всех точках.

   ПОЧЕМУ ИМЕННО ТАК. Заведение — не отдельный файл и не отдельная
   копия сайта, а ещё один уровень группировки поверх разделов: у
   раздела появилось поле venue, у категории закупки — тоже. Это дало
   главное: систему ролей переписывать не пришлось. Разделы нового
   заведения получают собственные id, поэтому роль 'tab:<id>' и так
   уникальна — в списке участников меняется только подпись, где теперь
   видно, вкладка какого заведения выдаётся.

   Раздел без поля venue означает первое заведение — ровно так же, как
   рецепт без section означает главный раздел. Поэтому сайт работает
   корректно ещё до того, как миграция запишет данные на сервер.
   ================================================================ */
const VENUE_MAIN_ID = 'venue-main';
const CURRENT_VENUE_KEY = 'r20_current_venue';

function getVenues() {
  if (Array.isArray(siteConfig.venues) && siteConfig.venues.length) return siteConfig.venues;
  // Старый сайт: всё, что уже есть, принадлежит единственному заведению.
  // Закупка у него включена — она там работала и до появления сети.
  return [{ id: VENUE_MAIN_ID, label: 'Route 20', icon: '🏠', purchase: true }];
}

function venueById(id) {
  return getVenues().filter(function(v) { return v.id === id; })[0] || null;
}

/* Заведение, которому принадлежит всё «безхозное» — записи, созданные
   до появления сети. */
function fallbackVenueId() {
  var all = getVenues();
  return all.length ? all[0].id : VENUE_MAIN_ID;
}

function venueLabel(id) {
  var v = venueById(id);
  return v ? ((v.icon ? v.icon + ' ' : '') + v.label) : 'Заведение';
}

function sectionVenueId(s) {
  return (s && s.venue) ? s.venue : fallbackVenueId();
}

function sectionsForVenue(venueId) {
  return getSections().filter(function(s) { return sectionVenueId(s) === venueId; });
}

/* Вкладка «Закупка» есть не у каждой точки: новое заведение создаётся
   полностью пустым, и закупку к нему добавляют отдельно — так же, как
   добавляют разделы. */
function venueHasPurchase(venueId) {
  var v = venueById(venueId);
  return !!(v && v.purchase);
}

/* Роль закупки привязана к заведению. У первого заведения она осталась
   прежней — просто 'purchase', — чтобы уже выданные роли продолжали
   работать без миграции участников. */
function purchaseRoleId(venueId) {
  return (venueId === fallbackVenueId()) ? 'purchase' : 'purchase:' + venueId;
}

/* Какие заведения показывать этому человеку. Админ и разработчик видят
   все; сотрудник — только те, где ему что-то открыто ролями. */
function venuesAvailableToMe() {
  var all = getVenues();
  if (isAdmin()) return all;
  return all.filter(function(v) {
    var hasSection = sectionsForVenue(v.id).some(function(s) { return hasSectionAccess(s.id); });
    return hasSection || hasPurchaseAccess(v.id);
  });
}

var currentVenue = ''; // выбранное на ЭТОМ устройстве заведение

function currentVenueId() {
  var list = venuesAvailableToMe();
  if (!list.length) return fallbackVenueId();
  if (currentVenue && list.some(function(v) { return v.id === currentVenue; })) return currentVenue;
  var stored = null;
  try { stored = localStorage.getItem(CURRENT_VENUE_KEY); } catch (e) {}
  if (stored && list.some(function(v) { return v.id === stored; })) { currentVenue = stored; return currentVenue; }
  currentVenue = list[0].id;
  return currentVenue;
}

function setCurrentVenue(id) {
  if (!venueById(id)) return;
  if (!isAdmin() && !venuesAvailableToMe().some(function(v) { return v.id === id; })) {
    showToast('🔒 Это заведение вам не открыто');
    return;
  }
  currentVenue = id;
  try { localStorage.setItem(CURRENT_VENUE_KEY, id); } catch (e) {}

  // Закупка своя у каждой точки — переводим её на категории нового
  // заведения, иначе на вкладке остался бы чужой цех.
  var pcats = venuePurchaseCategories(id);
  currentPurchaseCategory = pcats.length ? pcats[0].id : '';

  renderSectionNavTabs();
  refreshAllSectionLists();
  updateVenueSwitcher();
  // Вкладка, на которой человек стоял, принадлежит прежнему заведению —
  // уводим его в первый раздел выбранного.
  goToDefaultSection();
  if (currentTab === 'admin') renderAdminPanel();
  showToast('🏠 Заведение: ' + venueLabel(id));
}

/* Список разделов. Если в настройках их ещё нет — собираем на лету
   из старой схемы: главный раздел плюс прежние «дополнительные
   вкладки» в том же порядке. */
function getSections() {
  if (Array.isArray(siteConfig.sections) && siteConfig.sections.length) return siteConfig.sections;
  var migrated = defaultSections();
  if (Array.isArray(siteConfig.customTabs)) {
    siteConfig.customTabs.forEach(function(t) {
      if (t && t.id) migrated.push({ id: t.id, label: t.label || 'Вкладка', icon: t.icon || '📁' });
    });
  }
  return migrated;
}

function sectionById(id) {
  return getSections().filter(function(s) { return s.id === id; })[0] || null;
}

function sectionLabel(id) {
  var s = sectionById(id);
  return s ? ((s.icon ? s.icon + ' ' : '') + s.label) : 'Раздел';
}

/* Раздел, в который попадают записи без явной привязки (старые
   рецепты и категории, созданные до появления разделов). */
function fallbackSectionId() {
  if (sectionById(MAIN_SECTION_ID)) return MAIN_SECTION_ID;
  var all = getSections();
  return all.length ? all[0].id : MAIN_SECTION_ID;
}

function recipeSectionId(r) {
  return (r && r.section) ? r.section : fallbackSectionId();
}

function recipesForSection(sectionId) {
  return recipes.filter(function(r) { return recipeSectionId(r) === sectionId; });
}

/* Первый раздел, доступный ЭТОМУ человеку — куда его вести после
   сохранения рецепта, выхода из карточки и т.п. Если доступных нет
   (роли не выданы), возвращаем пустую строку — тогда вызывающий код
   просто никуда не переключается. */
function defaultSectionTab() {
  var visible = sectionsForVenue(currentVenueId()).filter(function(s) { return hasSectionAccess(s.id); });
  if (visible.length) return 'section:' + visible[0].id;
  // Разделов нет (новое заведение ещё пустое), но закупка уже может
  // быть — тогда ведём туда, чтобы человек не упирался в пустой экран.
  if (hasPurchaseAccess()) return 'purchase';
  return '';
}

function goToDefaultSection() {
  var t = defaultSectionTab();
  if (t) switchTab(t);
}

/* ================================================================
   ПЕРЕНОС СТАРЫХ ДАННЫХ НА СХЕМУ РАЗДЕЛОВ
   ================================================================
   Выполняется один раз, у разработчика (только у него есть право
   записи в GitHub). Всё, что делает: закрепляет вычисленный список
   разделов в настройках, проставляет section существующим категориям
   и рецептам и выдаёт роль главного раздела всем, кто уже пользуется
   сайтом, — чтобы после обновления никто не остался без вкладок.
   ================================================================ */
async function migrateToSections() {
  if (!isDeveloper()) return;

  // ГЛАВНАЯ ПРЕДОСТОРОЖНОСТЬ. Перенос сам, без участия человека,
  // записывает файлы на GitHub. Делать это можно ТОЛЬКО когда мы точно
  // видим актуальное содержимое сервера. Если получить его не удалось
  // (нет сети, отдался кэш, файл не открылся), в памяти лежит локальная
  // или вовсе зашитая в код копия — опубликовав её, мы бы стёрли всё,
  // что появилось на сервере позже. Поэтому при малейшем сомнении
  // перенос откладывается до следующего открытия сайта: он ничего не
  // ломает и спокойно подождёт.
  var canWriteConfig = (siteConfigSource === 'github' || siteConfigSource === 'missing');
  var canWriteRecipes = (dataSource === 'github');
  if (!canWriteConfig && !canWriteRecipes) return;

  var configChanged = false;

  // Заведения. Всё, что уже есть на сайте, принадлежит первой точке —
  // её и закрепляем в настройках, вместе с признаком, что закупка у неё
  // уже работает. Название можно изменить кнопкой «✏️» в админ-панели.
  if (!Array.isArray(siteConfig.venues) || !siteConfig.venues.length) {
    siteConfig.venues = getVenues();
    configChanged = true;
  }

  if (!Array.isArray(siteConfig.sections) || !siteConfig.sections.length) {
    siteConfig.sections = getSections();
    configChanged = true;
  }

  // Раздел без venue означает первую точку, но записать привязку явно
  // всё же нужно: иначе после создания второго заведения порядок точек
  // в настройках мог бы измениться, и «безхозные» разделы уехали бы не
  // туда.
  var mainVenue = fallbackVenueId();
  (siteConfig.sections || []).forEach(function(s) {
    if (!s.venue) { s.venue = mainVenue; configChanged = true; }
  });

  var cats = getRecipeCategories().slice();
  cats.forEach(function(c) {
    if (!c.section) { c.section = fallbackSectionId(); configChanged = true; }
  });
  if (!Array.isArray(siteConfig.categories) || !siteConfig.categories.length) {
    siteConfig.categories = cats; // стартовый набор ещё ни разу не сохраняли
    configChanged = true;
  }

  if (configChanged) {
    saveSiteConfigLocal();
    if (canWriteConfig) await syncSiteConfigToGithub();
  }

  // Рецепты живут в отдельном файле — их сохраняем своим запросом.
  var recipesChanged = false;
  recipes.forEach(function(r) {
    if (!r.section) { r.section = fallbackSectionId(); recipesChanged = true; }
  });
  if (recipesChanged) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes)); } catch (e) {}
    // Публикуем только если список рецептов действительно получен с
    // GitHub. Иначе на сервер уехала бы копия этого устройства, и
    // рецепты, добавленные другими позже, пропали бы.
    if (canWriteRecipes) await syncToGithub(false);
  }

  // Роль главного раздела — всем нынешним участникам, иначе после
  // обновления они увидели бы сайт вообще без единой вкладки.
  if (canWriteConfig && !siteConfig.mainRoleGranted && participants.length) {
    var mainRole = 'tab:' + fallbackSectionId();
    var touched = 0;
    participants.forEach(function(p) {
      if (!participantHasRole(p, mainRole)) {
        setParticipantRoles(p, getParticipantRoles(p).concat([mainRole]));
        touched++;
      }
    });
    siteConfig.mainRoleGranted = true;
    saveSiteConfigLocal();
    await syncSiteConfigToGithub();
    if (touched) {
      saveParticipantsLocal();
      await syncParticipantsToGithub();
      showToast('✅ Доступ к «' + sectionLabel(fallbackSectionId()) + '» выдан участникам: ' + touched);
    }
  }
}

/* ================================================================
   ОТРИСОВКА РАЗДЕЛОВ
   ================================================================ */
var sectionFilters = {};      // sectionId -> выбранная категория (чип)
var sectionCatsOpen = {};     // sectionId -> открыт ли блок управления категориями
/* sectionId -> какие статусы показывать админу: 'all' | id статуса.
   По умолчанию 'all': админ открывает раздел и сразу видит всё, что в
   нём есть, включая снятое с меню. Обычного сотрудника эта настройка
   не касается — ему всегда показываются только актуальные. */
var sectionStatusFilters = {};

function hasSectionAccess(sectionId) {
  if (isAdmin()) return true;
  var me = getMyParticipantRecord();
  return !!(me && !me.blocked && participantHasRole(me, 'tab:' + sectionId));
}

/* Создаёт панель содержимого раздела, если её ещё нет. Структура
   повторяет прежнюю вкладку «Категории»: поиск, чипы категорий,
   счётчик и список карточек — плюс панель управления для админа
   (добавить рецепт, править категории этого раздела). */
function ensureSectionContent(s) {
  var paneId = 'tab-section:' + s.id;
  if ($(paneId)) return;
  var container = $('sections-content');
  if (!container) return;
  var sid = s.id;
  var html = '<div id="' + paneId + '" class="tab-content">' +
    '<div class="section-controls">' +
    '<div class="search-wrap">' +
      '<svg class="search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>' +
      '<input type="search" class="search-input" id="search-section-' + sid + '" placeholder="Поиск по названию рецепта..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" oninput="renderSectionList(\'' + sid + '\'); toggleSearchClear(\'search-section-' + sid + '\')">' +
      '<button type="button" class="search-clear" id="search-section-' + sid + '-clear" onclick="clearSearchInput(\'search-section-' + sid + '\')" title="Очистить" style="display:none">✕</button>' +
    '</div>' +
    // Панель управления и фильтр актуальности стоят рядом: на широком
    // экране они выстраиваются в одну строку с поиском (см. .section-controls),
    // на телефоне переносятся друг под друга.
    '<div class="section-toolbar tool-bar admin-only">' +
      '<button type="button" class="tool-btn tool-btn-primary" data-perm="recipe.add" title="Добавить рецепт" onclick="openAddForm(\'' + sid + '\')"><span class="tool-btn-icon">➕</span><span class="tool-btn-label">Добавить рецепт</span></button>' +
      '<button type="button" class="tool-btn" data-perm="category.manage" title="Категории раздела" onclick="toggleSectionCategories(\'' + sid + '\')"><span class="tool-btn-icon">🏷️</span><span class="tool-btn-label">Категории</span></button>' +
    '</div>' +
    '<div class="chip-row status-filter-row admin-only" id="section-status-' + sid + '"></div>' +
    '</div>' + // конец .section-controls
    '<div class="chip-row" id="section-chips-' + sid + '"></div>' +
    '<div class="section-cats" id="section-cats-' + sid + '" style="display:none"></div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 16px;flex-wrap:wrap;gap:8px">' +
      '<span id="section-count-' + sid + '" style="font-size:14px;color:var(--text-muted)">Всего: 0</span>' +
    '</div>' +
    // Класс cards-grid включает многоколоночную раскладку на широком
    // экране (см. styles.css). На телефоне это обычный столбец.
    '<div class="cards-grid" id="section-list-' + sid + '"></div>' +
  '</div>';
  container.insertAdjacentHTML('beforeend', html);
}

function removeSectionContentPane(id) {
  var el = $('tab-section:' + id);
  if (el && el.parentNode) el.parentNode.removeChild(el);
  delete sectionFilters[id];
  delete sectionCatsOpen[id];
}

/* Перерисовывает верхнюю навигацию по текущему списку разделов.
   Показываются только те, к которым у человека есть доступ. */
function renderSectionNavTabs() {
  var container = $('section-nav-tabs');
  if (!container) return;
  // Показываем разделы ТОЛЬКО выбранного заведения: вкладки разных
  // точек в одной строке смешивать нельзя — сотрудник открывал бы
  // чужой цех, думая, что это его.
  var visible = sectionsForVenue(currentVenueId()).filter(function(s) { return hasSectionAccess(s.id); });
  visible.forEach(ensureSectionContent);
  updateVenueSwitcher();
  updatePurchaseTabVisibility();
  applyPermissionVisibility(); // панели разделов создаются здесь, кнопки в них тоже по правам
  updateMobileBar();
  updateNavPicker();

  // Открытый сейчас раздел стал недоступен (сняли роль, удалили
  // раздел) — уводим человека на первый доступный.
  if (currentTab.indexOf('section:') === 0) {
    var openId = currentTab.slice('section:'.length);
    var stillHere = visible.some(function(s) { return s.id === openId; });
    if (!stillHere) goToDefaultSection();
  }

  container.innerHTML = visible.map(function(s) {
    var tabName = 'section:' + s.id;
    return '<div class="nav-tab' + (currentTab === tabName ? ' active' : '') + '" data-tab="' + escAttr(tabName) + '" onclick="switchTab(\'' + tabName + '\')">' +
      '<span class="nav-icon" style="font-size:19px;line-height:1">' + esc(s.icon || '📁') + '</span>' +
      '<span class="nav-label">' + esc(s.label) + '</span>' +
    '</div>';
  }).join('');
}

/* Переключатель заведений в шапке. Кнопка показывается, только если
   переключать реально есть на что: у сотрудника одной точки она лишь
   мешала бы, а админ и разработчик видят все точки всегда. */
/* Нижняя панель на телефоне. «Рецепты» возвращают в тот раздел, где
   человек был до перехода в закупку или настройки, — а не в первый по
   списку: у повара горячего цеха первым идёт чужой пицца-бар. */
var lastSectionTab = '';

function mobileGoSections() {
  if (lastSectionTab && hasSectionAccess(lastSectionTab.slice('section:'.length))) {
    switchTab(lastSectionTab);
    return;
  }
  goToDefaultSection();
}

/* ================================================================
   ВЫБОР РАЗДЕЛА СПИСКОМ
   ================================================================
   Разделы были лентой вкладок с горизонтальной прокруткой. При шести
   разделах нужный уезжал за край, и чтобы его найти, приходилось
   листать вслепую. Теперь это кнопка с текущим разделом: нажал —
   открылся список целиком, выбрал — закрылся.

   Сами вкладки из разметки никуда не делись: список и есть они,
   просто показывается по нажатию. Поэтому вся логика доступа,
   подсветки и переключения осталась прежней. */
function toggleNavPicker(force) {
  var tabs = $('nav-tabs');
  var btn = $('nav-picker-btn');
  if (!tabs) return;
  var open = (typeof force === 'boolean') ? force : !tabs.classList.contains('open');
  tabs.classList.toggle('open', open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/* Подпись на кнопке — название открытого раздела. Человек должен
   видеть, где находится, не открывая список. */
function updateNavPicker() {
  var labelEl = $('nav-picker-label');
  var iconEl = $('nav-picker-icon');
  if (!labelEl) return;

  var label = 'Раздел', icon = '📁';
  if (currentTab === 'purchase') { label = 'Закупка'; icon = '🛒'; }
  else if (currentTab === 'admin') { label = 'Админ-панель'; icon = '⚙️'; }
  else {
    var id = (currentTab.indexOf('section:') === 0) ? currentTab.slice('section:'.length) : '';
    var s = id ? sectionById(id) : null;
    if (s) { label = s.label; icon = s.icon || '📁'; }
  }
  labelEl.textContent = label;
  if (iconEl) iconEl.textContent = icon;
}

/* Список закрывается при выборе и при нажатии мимо — иначе он
   перекрывал бы содержимое раздела, в который только что перешли. */
document.addEventListener('click', function(e) {
  var tabs = $('nav-tabs');
  if (!tabs || !tabs.classList.contains('open')) return;
  var insideBtn = e.target.closest && e.target.closest('.nav-picker-btn');
  if (insideBtn) return;
  var insideTabs = e.target.closest && e.target.closest('.nav-tabs');
  if (!insideTabs || e.target.closest('.nav-tab')) toggleNavPicker(false);
});

function updateMobileBar() {
  var bar = $('mobile-bar');
  if (!bar) return;
  var active = (currentTab.indexOf('section:') === 0 || currentTab === 'detail' || currentTab === 'add')
    ? 'sections'
    : currentTab;
  bar.querySelectorAll('.mobile-bar-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.mobile === active);
  });
}

function updateVenueSwitcher() {
  var btn = $('venue-switch-btn');
  if (!btn) return;
  var list = venuesAvailableToMe();
  var show = list.length > 1;
  btn.style.display = show ? '' : 'none';
  if (!show) return;
  var labelEl = btn.querySelector('.label');
  var v = venueById(currentVenueId());
  if (labelEl) labelEl.textContent = v ? v.label : 'Заведение';
  var iconEl = btn.querySelector('.icon');
  if (iconEl) iconEl.textContent = (v && v.icon) ? v.icon : '🏠';
}

async function openVenueSwitcher() {
  var list = venuesAvailableToMe();
  if (list.length < 2) return;
  var picked = await customSelect(
    'Все рецепты, категории и закупка у каждой точки свои. Переключение меняет только то, что вы видите, — данные других точек остаются на месте.',
    list.map(function(v) { return { value: v.id, label: (v.icon ? v.icon + ' ' : '') + v.label }; }),
    currentVenueId(),
    '🏠 Заведение'
  );
  if (!picked || picked === currentVenueId()) return;
  setCurrentVenue(picked);
}

/* Вкладка «Закупка» принадлежит конкретному заведению, поэтому её
   видимость нельзя оставить на одних CSS-классах роли: у выбранной
   точки закупки может не быть вовсе. */
function updatePurchaseTabVisibility() {
  var tab = document.querySelector('.nav-tab[data-tab="purchase"]');
  if (!tab) return;
  tab.classList.toggle('tab-hidden', !hasPurchaseAccess());
  if (currentTab === 'purchase' && !hasPurchaseAccess()) goToDefaultSection();
}

function selectSectionChip(sectionId, catId) {
  sectionFilters[sectionId] = catId;
  var row = $('section-chips-' + sectionId);
  if (row) row.querySelectorAll('.chip').forEach(function(chip) { chip.classList.toggle('active', chip.dataset.type === catId); });
  renderSectionList(sectionId);
}

function renderSectionList(sectionId) {
  var listEl = $('section-list-' + sectionId), countEl = $('section-count-' + sectionId);
  if (!listEl || !countEl) return;

  var cats = categoriesForSection(sectionId);
  var items = recipesForSection(sectionId);

  // Отсев по актуальности идёт ПЕРВЫМ: сотруднику неактуальные рецепты
  // не показываются вовсе, а админ смотрит через свой фильтр.
  if (!canSeeAllRecipeStatuses()) {
    items = items.filter(function(r) { return recipeStatus(r) === 'active'; });
  } else {
    var st = sectionStatusFilters[sectionId] || 'all';
    if (st !== 'all') items = items.filter(function(r) { return recipeStatus(r) === st; });
  }

  var filter = sectionFilters[sectionId] || '';
  if (filter) items = items.filter(function(r) { return r.type === filter; });
  items = applySearch(items, 'search-section-' + sectionId);

  // Пустой раздел: подсказываем следующий шаг вместо безликого «ничего
  // не найдено» — новый раздел создаётся без единой категории.
  if (!cats.length && !items.length) {
    countEl.textContent = 'Всего: 0';
    listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🏷️</div>' +
      '<h3>Раздел пока пустой</h3>' +
      '<p>' + (isAdmin()
        ? 'Начните с категории — например «Супы» или «Торты», — а затем добавьте в неё первый рецепт.'
        : 'Здесь пока нет рецептов.') + '</p></div>';
    return;
  }
  var emptyText = 'Ничего не найдено';
  if (canSeeAllRecipeStatuses() && (sectionStatusFilters[sectionId] || 'all') !== 'all' && !items.length) {
    emptyText = 'В этом разделе нет рецептов со статусом «' + statusMeta(sectionStatusFilters[sectionId]).label + '»';
  }
  renderCards(listEl, countEl, items, emptyText);
}

/* Блок управления категориями внутри раздела (виден админу по
   кнопке «🏷️ Категории»). Здесь же они и создаются: категории
   принадлежат разделу, поэтому и правятся там, где используются. */
function toggleSectionCategories(sectionId) {
  sectionCatsOpen[sectionId] = !sectionCatsOpen[sectionId];
  renderSectionCategoriesAdmin(sectionId);
}

function renderSectionCategoriesAdmin(sectionId) {
  var holder = $('section-cats-' + sectionId);
  if (!holder) return;
  if (!sectionCatsOpen[sectionId] || !isAdmin()) { holder.style.display = 'none'; return; }
  holder.style.display = '';

  var cats = categoriesForSection(sectionId);
  var rows = cats.length ? cats.map(function(c) {
    var count = recipes.filter(function(r) { return r.type === c.id; }).length;
    var sizes = categorySizes(c);
    return '<div class="participant-item">' +
      '<div style="min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span class="badge type-badge" style="background:' + escAttr(c.color || '#666') + '">' + esc((c.icon ? c.icon + ' ' : '') + c.label) + '</span>' +
        '<span style="font-size:12px;color:var(--text-muted)">' + count + ' рец.' + (sizes.length ? ' · размеров: ' + sizes.length : '') + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:4px;flex-shrink:0">' +
        '<button type="button" class="purchase-home-icon-btn" title="Список размеров/порций для этой категории" onclick="setCategorySizes(\'' + escAttr(c.id) + '\')">📏</button>' +
        '<button type="button" class="purchase-home-icon-btn" title="Переименовать" onclick="renameRecipeCategory(\'' + escAttr(c.id) + '\')">✏️</button>' +
        '<button type="button" class="purchase-home-icon-btn purchase-home-icon-btn-danger" title="Удалить" onclick="removeRecipeCategory(\'' + escAttr(c.id) + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  }).join('') : '<div class="purchase-home-empty">В этом разделе ещё нет категорий</div>';

  holder.innerHTML =
    '<div class="section-cats-title">Категории раздела «' + esc(sectionById(sectionId) ? sectionById(sectionId).label : '') + '»</div>' +
    rows +
    '<button type="button" class="btn btn-ghost btn-sm" style="margin-top:10px;width:100%" onclick="addRecipeCategory(\'' + escAttr(sectionId) + '\')">+ Добавить категорию</button>';
}

/* ================================================================
   УПРАВЛЕНИЕ ЗАВЕДЕНИЯМИ (Админ-панель)
   ================================================================ */
function renderVenuesAdminList() {
  var holder = $('venues-admin-list');
  if (!holder) return;
  var cur = currentVenueId();
  holder.innerHTML = getVenues().map(function(v) {
    var sectionCount = sectionsForVenue(v.id).length;
    var recipeCount = 0;
    sectionsForVenue(v.id).forEach(function(s) { recipeCount += recipesForSection(s.id).length; });
    var isCur = (v.id === cur);
    return '<div class="participant-item' + (isCur ? ' venue-current' : '') + '">' +
      '<div style="min-width:0">' +
        '<strong>' + esc((v.icon || '🏠') + ' ' + v.label) + (isCur ? ' <span class="role-badge">открыто сейчас</span>' : '') + '</strong>' +
        '<br><span style="font-size:12px;color:var(--text-muted)">разделов: ' + sectionCount + ' · рецептов: ' + recipeCount +
          ' · закупка: ' + (v.purchase ? 'есть' : 'нет') + '</span>' +
        (formatEditStamp(v) ? '<br><span class="edit-stamp-inline">✏️ ' + esc(formatEditStamp(v)) + '</span>' : '') +
      '</div>' +
      '<div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap">' +
        (isCur ? '' : '<button type="button" class="purchase-home-icon-btn" title="Открыть это заведение" onclick="setCurrentVenue(\'' + escAttr(v.id) + '\')">👁</button>') +
        '<button type="button" class="purchase-home-icon-btn" title="' + (v.purchase ? 'Убрать вкладку «Закупка»' : 'Добавить вкладку «Закупка»') + '" onclick="toggleVenuePurchase(\'' + escAttr(v.id) + '\')">🛒</button>' +
        '<button type="button" class="purchase-home-icon-btn" title="Переименовать" onclick="renameVenue(\'' + escAttr(v.id) + '\')">✏️</button>' +
        '<button type="button" class="purchase-home-icon-btn purchase-home-icon-btn-danger" title="Удалить заведение" onclick="removeVenue(\'' + escAttr(v.id) + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* Общая часть операций над заведениями: список точек лежит в
   site-config.json рядом с разделами, поэтому сохраняется тем же
   запросом, что и они. */
async function saveVenues(successMessage) {
  saveSiteConfigLocal();
  renderVenuesAdminList();
  renderSectionNavTabs();
  renderSectionsAdminList();
  refreshAllSectionLists();
  showToast('⏳ Сохраняю...');
  var ok = await syncSiteConfigToGithub();
  if (ok) showToast(successMessage);
  return ok;
}

/* Новое заведение создаётся ПУСТЫМ — без разделов, категорий и
   закупки. Так решили сознательно: у новой точки своё меню, и копия
   чужих вкладок только мешала бы, её пришлось бы вычищать вручную. */
async function addVenue() {
  if (!can('venue.manage')) { denyToast('venue.manage'); return; }
  var label = await customPrompt('Название заведения — например «Route 20 Центр», «Римские пекарни»:', '', '➕ Новое заведение');
  if (label === null) return;
  label = (label || '').trim();
  if (!label) { showToast('⚠️ Название не может быть пустым'); return; }

  var icon = await pickEmoji('venue', '🏠', '➕ Значок заведения «' + label + '»');
  if (icon === null) icon = '';
  icon = (icon || '').trim() || '🏠';

  var list = getVenues().slice();
  var id = 'v' + uid();
  list.push(stampEdit({ id: id, label: label, icon: icon, purchase: false }));
  siteConfig.venues = list;
  logActivity('создал заведение', 'Сеть', label);
  var ok = await saveVenues('✅ Заведение «' + label + '» создано — оно пустое, добавьте в него разделы');
  if (ok) setCurrentVenue(id); // сразу переводим туда, иначе непонятно, где создавать разделы
}

async function renameVenue(id) {
  if (!can('venue.manage')) { denyToast('venue.manage'); return; }
  var list = getVenues().slice();
  var v = list.filter(function(x) { return x.id === id; })[0];
  if (!v) return;

  var label = await customPrompt('Новое название заведения:', v.label, '✏️ Переименовать заведение');
  if (label === null) return;
  label = (label || '').trim();
  if (!label) { showToast('⚠️ Название не может быть пустым'); return; }

  var icon = await pickEmoji('venue', v.icon || '', '✏️ Значок заведения «' + label + '»');
  if (icon === null) icon = v.icon || '';

  var wasVenueName = v.label;
  v.label = label;
  v.icon = (icon || '').trim();
  stampEdit(v);
  siteConfig.venues = list;
  renderParticipantsList(); // в подписях ролей указано заведение — обновляем
  updateVenueSwitcher();
  logActivity('переименовал заведение', 'Сеть', wasVenueName + ' → ' + label);
  await saveVenues('✅ Заведение переименовано');
}

/* Вкладка «Закупка» включается и выключается отдельно, по тому же
   принципу, что и разделы: у новой точки её нет, пока не добавили.
   Выключение НЕ удаляет цеха и позиции — вкладка просто перестаёт
   показываться, и всё вернётся, если включить обратно. */
async function toggleVenuePurchase(id) {
  if (!can('venue.manage')) { denyToast('venue.manage'); return; }
  var list = getVenues().slice();
  var v = list.filter(function(x) { return x.id === id; })[0];
  if (!v) return;

  if (v.purchase) {
    var ok = await customConfirm(
      'Убрать вкладку «Закупка» у заведения «' + v.label + '»?\n\n' +
      'Цеха, поставщики и позиции сохранятся — вкладка просто перестанет показываться. ' +
      'Включите обратно, и всё вернётся.',
      '🛒 Убрать закупку'
    );
    if (!ok) return;
    v.purchase = false;
  } else {
    v.purchase = true;
  }
  siteConfig.venues = list;
  renderParticipantsList(); // роль закупки этой точки появляется/исчезает в списке ролей
  logActivity(v.purchase ? 'подключил вкладку «Закупка»' : 'убрал вкладку «Закупка»', v.label, '');
  await saveVenues(v.purchase
    ? '✅ Вкладка «Закупка» добавлена — заведите в ней цеха и поставщиков'
    : '✅ Вкладка «Закупка» убрана');
}

/* Удаление заведения уносит его разделы, категории и рецепты — как
   удаление раздела, только на уровень выше. Поэтому показываем, сколько
   всего пропадёт, и требуем подтверждения. Последнюю точку удалить
   нельзя: сайту нужно хотя бы одно заведение. */
async function removeVenue(id) {
  if (!can('venue.manage')) { denyToast('venue.manage'); return; }
  var list = getVenues().slice();
  if (list.length <= 1) { showToast('⚠️ Должно остаться хотя бы одно заведение'); return; }
  var v = list.filter(function(x) { return x.id === id; })[0];
  if (!v) return;

  var doomedSections = sectionsForVenue(id);
  var doomedRecipes = 0;
  doomedSections.forEach(function(s) { doomedRecipes += recipesForSection(s.id).length; });
  var doomedPurchase = purchaseCategories.filter(function(c) { return purchaseCategoryVenueId(c) === id; }).length;
  var doomedKeys = participants.filter(function(p) {
    return !isRevokedRecord(p) && participantVenueId(p) === id;
  }).length;

  var ok = await customConfirm(
    'Удалить заведение «' + v.label + '» со всем содержимым?\n\n' +
    'Пропадут: разделов — ' + doomedSections.length + ', рецептов — ' + doomedRecipes +
    (doomedPurchase ? ', цехов и поставщиков в закупке — ' + doomedPurchase : '') + '.\n\n' +
    (doomedKeys ? 'Ключи доступа этого заведения (' + doomedKeys + ') перестанут действовать — их владельцы потеряют доступ.\n\n' : '') +
    'Это действие необратимо.',
    '🗑️ Удалить заведение'
  );
  if (!ok) return;

  var sectionIds = doomedSections.map(function(s) { return s.id; });
  siteConfig.venues = list.filter(function(x) { return x.id !== id; });
  siteConfig.sections = getSections().filter(function(s) { return sectionVenueId(s) !== id; });
  siteConfig.categories = getRecipeCategories().filter(function(c) { return sectionIds.indexOf(categorySectionId(c)) === -1; });
  sectionIds.forEach(function(sid) { removeSectionContentPane(sid); });

  var hadRecipes = recipes.some(function(r) { return sectionIds.indexOf(recipeSectionId(r)) !== -1; });
  if (hadRecipes) {
    recipes = recipes.filter(function(r) { return sectionIds.indexOf(recipeSectionId(r)) === -1; });
    saveAll();
  }

  // Закупку этой точки убираем тем же действием, иначе её цеха остались
  // бы в файле навсегда, невидимые и не удаляемые.
  if (doomedPurchase) {
    purchaseCategories = purchaseCategories.filter(function(c) { return purchaseCategoryVenueId(c) !== id; });
    savePurchaseData();
    syncPurchaseToGithub();
  }

  // Ключи закрытой точки отзываем в том же действии: оставить их
  // рабочими значило бы, что люди уволенной смены продолжают заходить
  // на сайт, просто не видя своих вкладок.
  var revokedCount = revokeVenueKeys(id, v.label);
  if (revokedCount) {
    renderParticipantsList();
    await syncParticipantsToGithub();
    // Тем, кто сейчас на сайте, доступ закрываем сразу, не дожидаясь
    // фоновой проверки.
    for (var ki = 0; ki < participants.length; ki++) {
      var pk = participants[ki];
      if (pk.revoked && pk.revokedAt && (Date.now() - pk.revokedAt) < 5000) await signalDeviceKick(pk.id);
    }
  }

  if (currentVenue === id) currentVenue = '';
  logActivity('удалил заведение', 'Сеть', v.label + ' (разделов: ' + doomedSections.length +
    ', рецептов: ' + doomedRecipes + (revokedCount ? ', отозвано ключей: ' + revokedCount : '') + ')');
  await saveVenues('🗑 Заведение «' + v.label + '» удалено' + (revokedCount ? ' · отозвано ключей: ' + revokedCount : ''));
  setCurrentVenue(fallbackVenueId());
}

/* ================================================================
   УПРАВЛЕНИЕ РАЗДЕЛАМИ (Админ-панель → «🗂️ Вкладки»)
   ================================================================ */
function renderSectionsAdminList() {
  var holder = $('sections-admin-list');
  if (!holder) return;
  // Показываем разделы только открытого заведения: список всех точек
  // сразу превратился бы в кашу, где легко переименовать чужую вкладку.
  var list = sectionsForVenue(currentVenueId());
  var title = $('sections-admin-venue');
  if (title) title.textContent = 'Заведение: ' + venueLabel(currentVenueId());
  if (!list.length) {
    holder.innerHTML = '<p class="admin-panel-hint">В этом заведении ещё нет ни одного раздела. Нажмите «+ Добавить раздел».</p>';
    return;
  }
  holder.innerHTML = list.map(function(s) {
    var catCount = categoriesForSection(s.id).length;
    var recCount = recipesForSection(s.id).length;
    return '<div class="participant-item">' +
      '<div style="min-width:0">' +
        '<strong>' + esc(s.icon || '📁') + ' ' + esc(s.label) + '</strong>' +
        '<br><span style="font-size:12px;color:var(--text-muted)">категорий: ' + catCount + ' · рецептов: ' + recCount + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:4px;flex-shrink:0">' +
        '<button type="button" class="purchase-home-icon-btn" title="Переименовать" onclick="renameSection(\'' + escAttr(s.id) + '\')">✏️</button>' +
        '<button type="button" class="purchase-home-icon-btn purchase-home-icon-btn-danger" title="Удалить" onclick="removeSection(\'' + escAttr(s.id) + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* Общая часть всех операций над разделами. */
async function saveSections(successMessage) {
  saveSiteConfigLocal();
  renderSectionNavTabs();
  renderSectionsAdminList();
  refreshAllSectionLists();
  showToast('⏳ Сохраняю...');
  var ok = await syncSiteConfigToGithub();
  if (ok) showToast(successMessage);
  return ok;
}

async function addSection() {
  if (!can('section.manage')) { denyToast('section.manage'); return; }
  var label = await customPrompt('Название раздела — например «Горячий цех», «Кондитер», «Холодный цех»:', '', '➕ Новый раздел');
  if (label === null) return;
  label = (label || '').trim();
  if (!label) { showToast('⚠️ Название не может быть пустым'); return; }

  var icon = await pickEmoji('section', '🍽️', '➕ Значок раздела «' + label + '»');
  if (icon === null) icon = '';
  icon = (icon || '').trim() || '📁';

  var list = getSections().slice();
  // Раздел всегда заводится в том заведении, которое сейчас открыто, —
  // иначе он появился бы у чужой точки.
  var venue = currentVenueId();
  list.push(stampEdit({ id: uid(), label: label, icon: icon, venue: venue }));
  siteConfig.sections = list;
  logActivity('создал раздел', venueLabel(venue), label);
  await saveSections('✅ Раздел «' + label + '» создан в «' + venueLabel(venue) + '» — выдайте его роль тем, кто должен его видеть');
}

/* Переименование меняет подпись и иконку; id раздела не трогается,
   поэтому его рецепты, категории и уже выданная роль остаются. */
async function renameSection(id) {
  if (!can('section.manage')) { denyToast('section.manage'); return; }
  var list = getSections().slice();
  var s = list.filter(function(x) { return x.id === id; })[0];
  if (!s) return;

  var label = await customPrompt('Новое название раздела:', s.label, '✏️ Переименовать раздел');
  if (label === null) return;
  label = (label || '').trim();
  if (!label) { showToast('⚠️ Название не может быть пустым'); return; }

  var icon = await pickEmoji('section', s.icon || '', '✏️ Значок раздела «' + label + '»');
  if (icon === null) icon = s.icon || '';

  var was = s.label;
  s.label = label;
  s.icon = (icon || '').trim();
  stampEdit(s);
  siteConfig.sections = list;
  renderParticipantsList(); // подпись роли раздела берётся отсюда же
  logActivity('переименовал раздел', venueLabel(sectionVenueId(s)), was + ' → ' + label);
  await saveSections('✅ Раздел и его роль переименованы');
}

/* Удаление раздела уносит с собой ЕГО категории и ЕГО рецепты —
   в отличие от удаления одной категории, где рецепты переносятся.
   Поэтому спрашиваем явно и показываем, сколько всего пропадёт.
   Последний оставшийся раздел удалить нельзя. */
async function removeSection(id) {
  if (!can('section.manage')) { denyToast('section.manage'); return; }
  var list = getSections().slice();
  if (list.length <= 1) { showToast('⚠️ Должен остаться хотя бы один раздел'); return; }
  var s = list.filter(function(x) { return x.id === id; })[0];
  if (!s) return;

  var doomedRecipes = recipesForSection(id);
  var doomedCats = categoriesForSection(id);
  var roleId = 'tab:' + id;
  var affected = participants.filter(function(x) { return participantHasRole(x, roleId); });

  var ok = await customConfirm(
    'Удалить раздел «' + s.label + '»?\n\n' +
    'Вместе с ним будут удалены его категории (' + doomedCats.length + ') и все его рецепты (' + doomedRecipes.length + ').' +
    (affected.length ? ' Роль раздела исчезнет у участников: ' + affected.length + '.' : '') +
    '\n\nЭто действие нельзя отменить.',
    '🗑️ Удалить раздел'
  );
  if (!ok) return;

  siteConfig.sections = list.filter(function(x) { return x.id !== id; });
  siteConfig.categories = getRecipeCategories().filter(function(c) { return categorySectionId(c) !== id; });
  if (currentTab === 'section:' + id) goToDefaultSection();
  removeSectionContentPane(id);

  var hadRecipes = doomedRecipes.length > 0;
  if (hadRecipes) recipes = recipes.filter(function(r) { return recipeSectionId(r) !== id; });

  if (affected.length) {
    affected.forEach(function(x) {
      setParticipantRoles(x, getParticipantRoles(x).filter(function(r) { return r !== roleId; }));
    });
    saveParticipantsLocal();
    renderParticipantsList();
  }

  await saveSections('🗑️ Раздел удалён');
  if (hadRecipes) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes)); } catch (e) {}
    await syncToGithub(false);
  }
  if (affected.length) await syncParticipantsToGithub();
}

/* ================================================================
   РОЛИ УЧАСТНИКОВ (несколько ролей на одного человека)
   ================================================================
   У участника не одна роль, а массив p.roles — их можно выдавать
   пачкой (см. editParticipantRoles).

   Идентификаторы ролей:
     'admin'      — полноценный администратор (назначает только
                    разработчик и только с подтверждением ключом);
     'purchase'   — доступ к вкладке «Закупка»;
     'tab:<id>'   — доступ к разделу с этим id.

   Название роли раздела нигде отдельно не хранится — оно берётся из
   самого раздела. Поэтому переименование раздела переименовывает и
   его роль, а удаление раздела убирает роль из списка; записи
   'tab:<id>' у участников при этом вычищаются явно (см. removeSection).

   СОВМЕСТИМОСТЬ: participants.json может содержать записи со старым
   одиночным p.role. getParticipantRoles понимает оба формата, а
   setParticipantRoles всегда дописывает и старое поле.
   ================================================================ */
function getParticipantRoles(p) {
  if (!p) return [];
  if (Array.isArray(p.roles)) return p.roles.slice();
  if (p.role && p.role !== 'viewer') return [p.role]; // старый формат — одна роль строкой
  return [];
}

function participantHasRole(p, roleId) {
  return getParticipantRoles(p).indexOf(roleId) !== -1;
}

function setParticipantRoles(p, roles) {
  var uniq = [];
  (roles || []).forEach(function(r) { if (r && uniq.indexOf(r) === -1) uniq.push(r); });
  p.roles = uniq;
  // Старое одиночное поле role оставляем для совместимости. Закупочных
  // ролей теперь несколько (по одной на заведение) — в это поле пишем
  // общее 'purchase', если есть хоть одна из них.
  var anyPurchase = uniq.some(function(r) { return r === 'purchase' || r.indexOf('purchase:') === 0; });
  var anyAdmin = uniq.some(function(r) { return r === 'admin' || r.indexOf('admin:') === 0 || r === SUPERADMIN_ROLE; });
  p.role = anyAdmin ? 'admin' : (anyPurchase ? 'purchase' : 'viewer');
}

/* Полный список ролей сайта: две встроенные плюс по одной на раздел. */
function allRoleDefs() {
  var defs = [
    { id: SUPERADMIN_ROLE, label: '⭐ Главный администратор', hint: 'Полный доступ во всех заведениях сети, кроме настроек GitHub' }
  ];
  // Роли перечисляем по заведениям и подписываем названием точки: без
  // этого «🍕 Пицца бар» одного заведения не отличить от такого же
  // раздела другого, и роль легко выдать не туда.
  getVenues().forEach(function(v) {
    var vName = (v.icon ? v.icon + ' ' : '') + v.label;
    // Админ — теперь всегда админ конкретной точки: в сети из нескольких
    // заведений «просто админ» непонятно чего означал бы доступ ко всему.
    defs.push({
      id: adminRoleId(v.id),
      label: vName + ' · 👑 Администратор',
      hint: 'Управление рецептами, категориями и закупкой заведения «' + v.label + '»'
    });
    if (v.purchase) {
      defs.push({
        id: purchaseRoleId(v.id),
        label: vName + ' · 🛒 Закупка',
        hint: 'Вкладка «Закупка» заведения «' + v.label + '»'
      });
    }
    sectionsForVenue(v.id).forEach(function(s) {
      defs.push({
        id: 'tab:' + s.id,
        label: vName + ' · ' + (s.icon || '📁') + ' ' + s.label,
        hint: 'Раздел «' + s.label + '» в заведении «' + v.label + '»'
      });
    });
  });
  return defs;
}

/* Роли, относящиеся к одному заведению: его вкладки, его закупка и
   его администратор. Общая роль главного администратора сюда не
   входит — её выдают отдельно и осознанно, а не мимоходом при
   создании ключа для точки. */
function rolesForVenue(venueId) {
  var v = venueById(venueId);
  if (!v) return [];
  var mine = [adminRoleId(venueId), purchaseRoleId(venueId)];
  sectionsForVenue(venueId).forEach(function(s) { mine.push('tab:' + s.id); });
  return allRoleDefs().filter(function(d) { return mine.indexOf(d.id) !== -1; });
}

/* Заведение, для которого выдан ключ. У ключей, созданных до появления
   сети, привязки нет — считаем их ключами первой точки. */
function participantVenueId(p) {
  return (p && p.venue) ? p.venue : fallbackVenueId();
}

/* Отзыв всех ключей заведения. Вызывается при удалении точки: её люди
   не должны сохранять доступ, а сами ключи — оставаться рабочими.
   Отзываем так же, как при удалении участника, — пометкой, чтобы отказ
   работал даже по устаревшей копии данных (см. isRevokedRecord). */
function revokeVenueKeys(venueId, venueName) {
  var affected = participants.filter(function(p) {
    return !isRevokedRecord(p) && participantVenueId(p) === venueId;
  });
  if (!affected.length) return 0;
  var by = currentActorLabel();
  affected.forEach(function(p) {
    p.revoked = true;
    p.revokedAt = Date.now();
    p.revokedBy = by;
    p.revokedReason = 'удалено заведение «' + venueName + '»';
  });
  participants = purgeOldRevoked(participants);
  return affected.length;
}

function roleLabel(roleId) {
  var def = allRoleDefs().filter(function(d) { return d.id === roleId; })[0];
  if (def) return def.label;
  if (roleId.indexOf('tab:') === 0) return '📁 (удалённый раздел)';
  if (roleId.indexOf('purchase:') === 0) return '🛒 (закупка удалённого заведения)';
  if (roleId.indexOf('admin:') === 0) return '👑 (админ удалённого заведения)';
  return roleId;
}

/* ================================================================
   КАТЕГОРИИ РЕЦЕПТОВ (чипы внутри раздела)
   ================================================================
   Категория принадлежит одному разделу (поле section) — у пиццерии
   свои, у кондитера свои. Раньше набор был общий и зашит в код в
   четырёх местах сразу (разметка чипов, список «Тип» в форме, эмодзи
   и подписи бейджей, цвета в стилях); теперь он целиком лежит в
   настройках сайта и правится прямо внутри раздела.

   Поля категории: { id, label, icon, color, sizes, section }
     id      — то, что записано в recipe.type; при переименовании
               НЕ меняется, иначе рецепты «потеряются»;
     sizes   — список вариантов для поля «Размер» в форме рецепта.
               У пиццы это диаметры, у кондитера — формы, у горячего
               цеха — порции. Пустой список = поле не показывать.
               Старое булево поле hasSize понимается как «показывать
               прежний пиццейный список» (см. categorySizes).
   ================================================================ */
var LEGACY_PIZZA_SIZES = ['Маленькая (25 см)', 'Средняя (30 см)', 'Большая (35 см)', 'Очень большая (40+ см)'];

function defaultRecipeCategories() {
  return [
    { id: 'pizza',    label: 'Пицца',     icon: '🍕', color: '#b23a45', sizes: LEGACY_PIZZA_SIZES.slice(), section: MAIN_SECTION_ID },
    { id: 'pinsa',    label: 'Пинца',     icon: '🫓', color: '#8a6033', sizes: LEGACY_PIZZA_SIZES.slice(), section: MAIN_SECTION_ID },
    { id: 'dough',    label: 'Тесто',     icon: '🌾', color: '#5b6b85', sizes: [], section: MAIN_SECTION_ID },
    { id: 'sauce',    label: 'Соусы',     icon: '🥫', color: '#3d7a5c', sizes: [], section: MAIN_SECTION_ID },
    { id: 'prep',     label: 'Заготовки', icon: '🧂', color: '#7c5aa3', sizes: [], section: MAIN_SECTION_ID },
    { id: 'focaccia', label: 'Фокачча',   icon: '🫓', color: '#a3821f', sizes: LEGACY_PIZZA_SIZES.slice(), section: MAIN_SECTION_ID },
    { id: 'burger',   label: 'Бургер',    icon: '🍔', color: '#94502a', sizes: [], section: MAIN_SECTION_ID }
  ];
}

var CATEGORY_COLOR_PALETTE = [
  '#b23a45', '#3d7a5c', '#5b6b85', '#8a6033', '#7c5aa3',
  '#a3821f', '#94502a', '#2f6f7e', '#8a3f6b', '#4a6f2f'
];

function getRecipeCategories() {
  var list = siteConfig.categories;
  return (Array.isArray(list) && list.length) ? list : defaultRecipeCategories();
}

function categorySectionId(c) {
  return (c && c.section) ? c.section : fallbackSectionId();
}

function categoriesForSection(sectionId) {
  return getRecipeCategories().filter(function(c) { return categorySectionId(c) === sectionId; });
}

function recipeCategoryById(id) {
  return getRecipeCategories().filter(function(c) { return c.id === id; })[0] || null;
}

/* Варианты для поля «Размер». Старое булево hasSize приводим к
   прежнему пиццейному списку — чтобы у уже заполненных категорий
   ничего не изменилось. */
function categorySizes(c) {
  if (!c) return [];
  if (Array.isArray(c.sizes)) return c.sizes;
  return c.hasSize ? LEGACY_PIZZA_SIZES.slice() : [];
}

function firstCategoryIdForSection(sectionId) {
  var cats = categoriesForSection(sectionId);
  return cats.length ? cats[0].id : '';
}

/* Строка чипов раздела: «Все» плюс по чипу на каждую его категорию. */
function categoryChipsHtml(sectionId, activeType) {
  /* У каждой категории показываем, сколько в ней рецептов. Без счётчика
     непонятно, есть ли там вообще что-то: человек нажимал «Заготовки» и
     упирался в пустой список. Считаем по тем же правилам видимости, что
     и сам список, — иначе цифра расходилась бы с содержимым. */
  var visible = recipesForSection(sectionId).filter(function(r) {
    return canSeeAllRecipeStatuses() || recipeStatus(r) === 'active';
  });
  var html = '<span class="chip' + (!activeType ? ' active' : '') + '" data-type="" onclick="selectSectionChip(\'' + sectionId + '\', \'\')">' +
    'Все<span class="chip-count">' + visible.length + '</span></span>';
  categoriesForSection(sectionId).forEach(function(c) {
    var n = visible.filter(function(r) { return r.type === c.id; }).length;
    html += '<span class="chip' + (activeType === c.id ? ' active' : '') + '" data-type="' + escAttr(c.id) + '"' +
      ' onclick="selectSectionChip(\'' + sectionId + '\', \'' + escAttr(c.id) + '\')">' +
      esc((c.icon ? c.icon + ' ' : '') + c.label) + '<span class="chip-count">' + n + '</span></span>';
  });
  return html;
}

/* Фильтр по актуальности — только для админа и разработчика.
   Показывается отдельной строкой над списком, чтобы не смешиваться с
   чипами категорий: это разные оси отбора и их часто применяют вместе
   (например «Пиццы» + «Убранное из меню»). */
function statusFilterHtml(sectionId) {
  var active = sectionStatusFilters[sectionId] || 'all';
  var opts = RECIPE_STATUSES.map(function(s) {
    return { id: s.id, label: s.icon + ' ' + s.label };
  });
  opts.push({ id: 'all', label: '👁 Показать всё' });
  return opts.map(function(o) {
    return '<span class="chip status-chip' + (active === o.id ? ' active' : '') + '"' +
      ' data-status="' + escAttr(o.id) + '"' +
      ' onclick="selectStatusFilter(\'' + escAttr(sectionId) + '\', \'' + escAttr(o.id) + '\')">' + esc(o.label) + '</span>';
  }).join('');
}

function renderStatusFilterRows() {
  getSections().forEach(function(s) {
    var row = $('section-status-' + s.id);
    if (row) row.innerHTML = statusFilterHtml(s.id);
  });
}

function selectStatusFilter(sectionId, value) {
  sectionStatusFilters[sectionId] = value;
  var row = $('section-status-' + sectionId);
  if (row) row.querySelectorAll('.status-chip').forEach(function(chip) {
    chip.classList.toggle('active', chip.dataset.status === value);
  });
  renderSectionList(sectionId);
}

/* Перерисовывает чипы во всех уже созданных панелях разделов. */
function renderCategoryChipRows() {
  getSections().forEach(function(s) {
    var row = $('section-chips-' + s.id);
    if (!row) return;
    var ids = categoriesForSection(s.id).map(function(c) { return c.id; });
    if (sectionFilters[s.id] && ids.indexOf(sectionFilters[s.id]) === -1) sectionFilters[s.id] = '';
    row.innerHTML = categoryChipsHtml(s.id, sectionFilters[s.id] || '');
  });
}

function refreshAllSectionLists() {
  getSections().forEach(function(s) {
    if ($('section-list-' + s.id)) renderSectionList(s.id);
    renderSectionCategoriesAdmin(s.id);
  });
  renderStatusFilterRows(); // состав фильтра не меняется, но подсветка выбранного — да
}

/* Выпадающий список «Тип» в форме рецепта — только категории того
   раздела, в который сейчас добавляется рецепт. */
function renderTypeSelect() {
  var sel = $('f-type');
  if (!sel) return;
  var keep = sel.value;
  var cats = categoriesForSection(currentFormSection());
  sel.innerHTML = cats.map(function(c) {
    return '<option value="' + escAttr(c.id) + '">' + esc((c.icon ? c.icon + ' ' : '') + c.label) + '</option>';
  }).join('');
  if (keep && cats.some(function(c) { return c.id === keep; })) sel.value = keep;
}

/* Заполняет список «Размер» вариантами выбранной категории. */
function renderSizeSelect(categoryId, keepValue) {
  var sel = $('f-size');
  var group = $('f-size-group');
  if (!sel || !group) return;
  var sizes = categorySizes(recipeCategoryById(categoryId));
  if (!sizes.length) { group.style.display = 'none'; sel.innerHTML = ''; return; }
  group.style.display = '';
  var html = '<option value="">Выберите...</option>';
  var known = false;
  sizes.forEach(function(v) {
    if (v === keepValue) known = true;
    html += '<option value="' + escAttr(v) + '">' + esc(v) + '</option>';
  });
  // Значение из уже сохранённого рецепта, которого нет в текущем
  // списке (список правили после), не теряем — показываем как есть.
  if (keepValue && !known) html += '<option value="' + escAttr(keepValue) + '">' + esc(keepValue) + ' (прежнее)</option>';
  sel.innerHTML = html;
  if (keepValue) sel.value = keepValue;
}

/* ================================================================
   ОПЕРАЦИИ НАД КАТЕГОРИЯМИ
   ================================================================ */
async function saveRecipeCategories(successMessage) {
  saveSiteConfigLocal();
  renderCategoryChipRows();
  renderTypeSelect();
  refreshAllSectionLists();
  showToast('⏳ Сохраняю...');
  var ok = await syncSiteConfigToGithub();
  if (ok) showToast(successMessage);
  return ok;
}

async function addRecipeCategory(sectionId) {
  if (!can('category.manage')) { denyToast('category.manage'); return; }
  sectionId = sectionId || fallbackSectionId();
  var label = await customPrompt('Название категории в разделе «' + (sectionById(sectionId) || {}).label + '»:', '', '➕ Новая категория');
  if (label === null) return;
  label = (label || '').trim();
  if (!label) { showToast('⚠️ Название не может быть пустым'); return; }

  var icon = await pickEmoji('category', '🍽️', '➕ Значок категории «' + label + '»');
  if (icon === null) icon = '';
  icon = (icon || '').trim();

  var cats = getRecipeCategories().slice();
  cats.push({
    id: uid(),
    label: label,
    icon: icon,
    color: CATEGORY_COLOR_PALETTE[cats.length % CATEGORY_COLOR_PALETTE.length],
    sizes: [],
    section: sectionId,
    updatedAt: Date.now(),
    updatedBy: currentActorLabel()
  });
  siteConfig.categories = cats;
  sectionCatsOpen[sectionId] = true;
  await saveRecipeCategories('✅ Категория «' + label + '» добавлена');
}

async function renameRecipeCategory(id) {
  if (!can('category.manage')) { denyToast('category.manage'); return; }
  var cats = getRecipeCategories().slice();
  var c = cats.filter(function(x) { return x.id === id; })[0];
  if (!c) return;

  var label = await customPrompt('Новое название категории:', c.label, '✏️ Переименовать категорию');
  if (label === null) return;
  label = (label || '').trim();
  if (!label) { showToast('⚠️ Название не может быть пустым'); return; }

  var icon = await pickEmoji('category', c.icon || '', '✏️ Значок категории «' + label + '»');
  if (icon === null) icon = c.icon || '';

  c.label = label;
  c.icon = (icon || '').trim();
  stampEdit(c);
  siteConfig.categories = cats;
  await saveRecipeCategories('✅ Категория переименована');
}

/* Список вариантов поля «Размер» для категории. Именно это делает
   форму универсальной: у пиццы тут диаметры, у кондитера — формы
   («Ø 18 см», «Ø 24 см»), у горячего цеха — порции («Порция 250 г»).
   Пустой список означает, что поля «Размер» у этой категории нет. */
async function setCategorySizes(id) {
  if (!can('category.manage')) { denyToast('category.manage'); return; }
  var cats = getRecipeCategories().slice();
  var c = cats.filter(function(x) { return x.id === id; })[0];
  if (!c) return;

  var current = categorySizes(c).join(', ');
  var val = await customPrompt(
    'Варианты поля «Размер» для категории «' + c.label + '» — через запятую.\n\n' +
    'Например: Ø 25 см, Ø 30 см, Ø 35 см — или Порция 250 г, Порция 400 г.\n' +
    'Оставьте пустым, чтобы убрать поле «Размер» у этой категории.',
    current, '📏 Размеры — ' + c.label
  );
  if (val === null) return;

  c.sizes = (val || '').split(',').map(function(x) { return x.trim(); }).filter(Boolean);
  delete c.hasSize; // старое булево поле больше не участвует
  siteConfig.categories = cats;
  if (currentTab === 'add') onTypeChange();
  await saveRecipeCategories(c.sizes.length
    ? '📏 Сохранено вариантов: ' + c.sizes.length
    : '📏 Поле «Размер» убрано у «' + c.label + '»');
}

/* Удаление категории: если в ней есть рецепты, сначала спрашиваем,
   в какую категорию ТОГО ЖЕ раздела их перенести. Рецепты при
   удалении категории не пропадают никогда. */
async function removeRecipeCategory(id) {
  if (!can('category.manage')) { denyToast('category.manage'); return; }
  var cats = getRecipeCategories().slice();
  var c = cats.filter(function(x) { return x.id === id; })[0];
  if (!c) return;
  var sectionId = categorySectionId(c);
  var siblings = categoriesForSection(sectionId).filter(function(x) { return x.id !== id; });

  var affected = recipes.filter(function(r) { return r.type === id; });
  var moveTo = null;

  if (affected.length) {
    if (!siblings.length) {
      showToast('⚠️ Это единственная категория раздела — сначала создайте другую, чтобы перенести в неё рецепты');
      return;
    }
    var options = siblings.map(function(x) { return { value: x.id, label: (x.icon ? x.icon + ' ' : '') + x.label }; });
    moveTo = await customSelect(
      'В категории «' + c.label + '» сейчас рецептов: ' + affected.length + '.\n\n' +
      'Выберите, в какую категорию этого же раздела их перенести — после этого «' + c.label + '» будет удалена.',
      options, options[0].value, '🗑️ Удалить категорию'
    );
    if (moveTo === null) return;
  } else {
    var ok = await customConfirm('Удалить категорию «' + c.label + '»? В ней нет ни одного рецепта.', '🗑️ Удалить категорию');
    if (!ok) return;
  }

  if (affected.length) affected.forEach(function(r) { r.type = moveTo; });

  siteConfig.categories = cats.filter(function(x) { return x.id !== id; });
  await saveRecipeCategories(affected.length
    ? '🗑️ Категория удалена, рецептов перенесено: ' + affected.length
    : '🗑️ Категория удалена');

  if (affected.length) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes)); } catch (e) {}
    await syncToGithub(false);
  }
}

/* ================================================================
   СИНХРОНИЗАЦИЯ ШАБЛОНА ЗАКУПКИ (purchase.json)
   ================================================================
   Список позиций (название/ед./норма на неделю) — это общий шаблон
   для всей команды: его составляют и сохраняют только владелец и
   администраторы (через уже настроенный GitHub-токен), остальные
   посетители видят его готовым и не могут менять. Поле "Остаток" —
   наоборот, вводит на месте любой сотрудник, который считает
   продукты прямо сейчас; оно НЕ синхронизируется и не сохраняется
   на GitHub — это разовый расчёт для конкретного похода "докупить",
   после которого результат копируют/скачивают кнопками ниже.
   ================================================================ */
const PURCHASE_PATH = 'purchase.json';

/* Список категорий закупки хранится ВМЕСТЕ с позициями в одном файле
   purchase.json: { categories: [{id,label,icon,builtin,workshop}],
   data: { id: [строки] } }.
   Флаг builtin помечает "цех" (в отличие от поставщика): у цеха есть
   свой общий список/отчёт, объединяющий его самого и всех привязанных
   к нему поставщиков (см. purchaseCategoriesForWorkshop). Изначально
   есть два цеха — Пицца бар и Горячий цех, — они задаются этой функцией
   как стартовый набор для нового/пустого сайта, но, как и любой другой
   цех или поставщик, добавленный позже, могут быть переименованы и
   удалены администратором насовсем (см. removePurchaseCategory) — после
   удаления обратно не восстанавливаются. Поверх цехов администратор
   также может добавлять сколько угодно "поставщиков" — категории с
   builtin:false, привязываемые к любому цеху через workshop, — под
   каждую свой список позиций с нормой на неделю и тем же расчётом
   "сколько докупить". Старый формат файла ({pizza:[...], hot:[...]}
   без categories) распознаётся и на лету преобразуется в новый —
   старые сайты не ломаются при обновлении. */
/* Цех или поставщик принадлежит одному заведению. Записи без venue —
   из времён, когда точка была одна, поэтому считаем их первой. */
function purchaseCategoryVenueId(c) {
  return (c && c.venue) ? c.venue : fallbackVenueId();
}

function venuePurchaseCategories(venueId) {
  var v = venueId || currentVenueId();
  return purchaseCategories.filter(function(c) { return purchaseCategoryVenueId(c) === v; });
}

function defaultPurchaseCategories() {
  return [
    { id: 'pizza', label: 'Пицца бар', icon: '🍕', builtin: true },
    { id: 'hot', label: 'Горячий цех', icon: '🔥', builtin: true }
  ];
}

/* Объединяет серверный список цехов и поставщиков с локальным: если
   местная запись помечена более поздним изменением (stampEdit), она
   побеждает. Сравниваем по времени правки, а не «локальное всегда
   главнее» — иначе изменения коллег никогда бы не доезжали. */
function mergeFresherCategories(fromServer, local) {
  var byId = {};
  (fromServer || []).forEach(function(c) { byId[c.id] = c; });
  (local || []).forEach(function(mine) {
    var theirs = byId[mine.id];
    if (!theirs) return; // у сервера такой записи нет — не воскрешаем удалённое
    if ((mine.updatedAt || 0) > (theirs.updatedAt || 0)) byId[mine.id] = mine;
  });
  // Порядок берём серверный: он общий для всех.
  return (fromServer || []).map(function(c) { return byId[c.id] || c; });
}

async function syncPurchaseFromGithub() {
  // Пока админ активно редактирует шаблон (режим включён кнопкой
  // "✏️ Редактировать шаблон"), фоновое обновление с GitHub НЕ должно
  // подменять список: раньше строка, только что добавленная кнопкой
  // "+ Добавить ингредиент", могла исчезнуть буквально через долю
  // секунды — потому что параллельный фоновый fetch этой функции успевал
  // прийти со старой версией с GitHub (ещё без новой строки) и полностью
  // затирал purchaseData. Снаружи режима редактирования — синхронизация
  // как обычно.
  if (isAdmin() && purchaseTemplateEditMode) return;
  try {
    var res = await fetch('./' + PURCHASE_PATH + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return; // файла ещё нет (шаблон не настраивали) или открыто локально — тихий фолбэк
    var data = await res.json();
    // Ещё одна проверка после await fetch()/await res.json(): пока мы
    // ждали ответ сети, админ мог успеть нажать "Редактировать шаблон"
    // и добавить строки — не затираем их результатом, который уже устарел.
    if (isAdmin() && purchaseTemplateEditMode) return;
    if (!data || typeof data !== 'object') return;

    var incomingCategories, incomingData;
    if (Array.isArray(data.categories) && data.data && typeof data.data === 'object') {
      incomingCategories = data.categories;
      incomingData = data.data;
    } else {
      // старый формат файла — только pizza/hot без списка категорий
      incomingCategories = defaultPurchaseCategories();
      incomingData = { pizza: Array.isArray(data.pizza) ? data.pizza : [], hot: Array.isArray(data.hot) ? data.hot : [] };
    }
    // Свежие локальные правки не отдаём на съедение отстающей копии.
    // Копия на GitHub Pages обновляется до минуты, и без этого только
    // что сохранённый идентификатор чата (или контакты, или ссылка)
    // исчезал при первом же обновлении страницы: приходил файл, где
    // правки ещё нет, и подменял собой список целиком.
    incomingCategories = mergeFresherCategories(incomingCategories, purchaseCategories);

    // Если категорий не осталось вообще (например, удалили все цеха и
    // всех поставщиков) — подстраховка, чтобы не остаться без единой
    // категории; конкретные же удалённые цеха/поставщики НЕ
    // восстанавливаем — удаление постоянно, как и для любой другой
    // категории (см. removePurchaseCategory).
    if (!Array.isArray(incomingCategories) || !incomingCategories.length) incomingCategories = defaultPurchaseCategories();
    incomingCategories.forEach(function(c) { if (!Array.isArray(incomingData[c.id])) incomingData[c.id] = []; });
    purchaseCustomUnits = Array.isArray(data.customUnits) ? data.customUnits : [];

    // Остатки и дозаказ, введённые прямо сейчас на этом устройстве, —
    // локальные и временные, поэтому при обновлении шаблона с GitHub
    // переносим их на новые данные по id строки, а не затираем.
    incomingCategories.forEach(function(c) {
      var localResidualById = {};
      var localReorderById = {};
      purchaseRowsFor(c.id).forEach(function(r) { localResidualById[r.id] = r.residual; localReorderById[r.id] = r.reorder; });
      incomingData[c.id].forEach(function(r) {
        r.residual = (r.id in localResidualById) ? localResidualById[r.id] : '';
        r.reorder = (r.id in localReorderById) ? localReorderById[r.id] : '';
      });
    });

    purchaseCategories = incomingCategories;
    purchaseData = incomingData;
    ensurePurchaseCategoryOfVenue();
    savePurchaseData();
  } catch (e) {
    console.warn('syncPurchaseFromGithub: используются локальные данные', e);
  }
}

function syncPurchaseToGithub() {
  return queueGithubWrite('purchase', async function() {
    var cfg = getGithubConfig();
    if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) {
      showToast('⚠️ Сначала настройте синхронизацию с GitHub (⚙️ в разделе «Добавить»)');
      return false;
    }
    // Остатки — личный черновик устройства, в общий шаблон их не публикуем.
    var toSave = { categories: purchaseCategories, data: {}, customUnits: purchaseCustomUnits };
    purchaseCategories.forEach(function(c) {
      toSave.data[c.id] = purchaseRowsFor(c.id).map(function(r) { return { id: r.id, name: r.name, unit: r.unit, norm: r.norm }; });
    });
    var res = await putJsonToGithub(PURCHASE_PATH, toSave, 'Обновление шаблона закупки (' + new Date().toLocaleString('ru-RU') + ')');
    if (res.ok) return true;
    console.error('syncPurchaseToGithub error:', res.error);
    showToast('⚠️ Не удалось сохранить шаблон закупки: ' + res.error);
    return false;
  });
}

var purchaseSyncDebounceTimer = null;
function schedulePurchaseSync() {
  clearTimeout(purchaseSyncDebounceTimer);
  purchaseSyncDebounceTimer = setTimeout(function() { syncPurchaseToGithub(); }, 900);
}

async function saveAdminTelegramUsername() {
  if (!can('site.settings')) { denyToast('site.settings'); return; }
  var input = $('admin-telegram-username');
  if (!input) return;
  var val = input.value.trim().replace(/^@/, '');
  siteConfig.adminTelegram = val;
  showToast('⏳ Сохраняю...');
  var ok = await syncSiteConfigToGithub();
  if (ok) showToast('✅ Telegram-юзернейм сохранён');
  // при ok===false внутри syncSiteConfigToGithub уже показан toast с точной причиной — не перезаписываем его
}

/* Ссылка-приглашение в Telegram-группу администратора. Если заполнено —
   используется ВМЕСТО личного юзернейма выше: гость открывает эту
   ссылку и сам пишет туда сообщение с именем и кодом устройства
   (см. requireTelegramSend). */
async function saveAdminTelegramGroupLink() {
  if (!can('site.settings')) { denyToast('site.settings'); return; }
  var input = $('admin-telegram-group');
  if (!input) return;
  var val = input.value.trim();
  siteConfig.adminTelegramGroup = val;
  showToast('⏳ Сохраняю...');
  var ok = await syncSiteConfigToGithub();
  if (ok) showToast('✅ Ссылка на группу сохранена');
  // при ok===false внутри syncSiteConfigToGithub уже показан toast с точной причиной — не перезаписываем его
}

/* Предлагаем гостю после ввода имени отправить его имя и код устройства
   администратору в Telegram одним нажатием — чтобы не диктовать код
   голосом. Работает только если администратор один раз указал свой
   Telegram-юзернейм в админ-панели. */
/* Ссылка на Telegram для отправки заявки — обычная https://t.me/...
   ссылка, без кастомных tg:// протоколов и таймеров-фолбэков (раньше
   именно эта логика иногда вместо Telegram открывала пустую
   telegram.org: если сообщение не успевало уйти по tg://, код через
   1200мс тихо открывал веб-фолбэк, и при пустом/некорректном
   юзернейме t.me/?text=... редиректил на главную telegram.org).
   Обычная ссылка t.me сама по себе работает как нужно в любом
   браузере и на любом устройстве: на телефоне её подхватывает
   установленное приложение Telegram, иначе открывается веб-версия —
   никаких скрытых шагов.
   Для группы используем ссылку-приглашение как есть (Telegram не
   поддерживает предзаполнение текста для групп по инвайт-ссылке —
   гость откроет группу и напишет сообщение сам). Для личного
   юзернейма — ссылка с уже готовым текстом. */
function getTelegramSendUrl(name) {
  if (siteConfig.adminTelegramGroup) return siteConfig.adminTelegramGroup;
  if (siteConfig.adminTelegram) {
    var text = buildAccessRequestText(name);
    return 'https://t.me/' + encodeURIComponent(siteConfig.adminTelegram) + '?text=' + encodeURIComponent(text);
  }
  return null;
}

function openTelegramSend(name) {
  var url = getTelegramSendUrl(name);
  if (!url) { showToast('⚠️ Администратор пока не указал Telegram для приёма заявок'); return; }
  window.open(url, '_blank', 'noopener');
}

function buildAccessRequestText(name) {
  var code = getCombinedAccessCode();
  return 'Здравствуйте! Хочу получить доступ к книге рецептов Route 20 🍕\nИмя: ' + (name || '—') + '\nКод устройства: ' + code;
}

/* Сообщение для случая "ключ несколько раз подряд не подошёл" —
   отдельный текст от обычной первой заявки, чтобы администратор сразу
   видел контекст (это не первое обращение, а результат неудачного
   подбора) и мог решить, выдавать ли новый ключ. */
function buildKeyLockedRequestText(name) {
  var code = getCombinedAccessCode();
  return '⚠️ Не подошёл ключ доступа к книге рецептов Route 20 (несколько попыток подряд).\nИмя: ' + (name || '—') + '\nКод устройства: ' + code + '\nПрошу выдать/уточнить ключ.';
}

/* Сообщение с экрана "Доступ закрыт" — гость просит пересмотреть
   блокировку или выдать новый ключ. Тоже отдельный текст, чтобы
   администратор сразу видел, что пишет именно заблокированный. */
function buildBlockedRequestText(name) {
  var code = getCombinedAccessCode();
  return '🔒 Мне закрыли доступ к книге рецептов Route 20, прошу пересмотреть или выдать новый ключ.\nИмя: ' + (name || '—') + '\nКод устройства: ' + code;
}

/* ================================================================
   КНОПКИ «ЗАПРОСИТЬ КЛЮЧ» — ПОЧЕМУ ЭТО ССЫЛКИ, А НЕ КНОПКИ
   ================================================================
   Раньше кнопка сначала тянула свежий site-config.json (вдруг
   администратор сменил юзернейм), и только потом вызывала
   window.open. Между нажатием и открытием оказывался await, то есть
   ожидание сети, — а браузер разрешает открыть новую вкладку только
   в непосредственный ответ на нажатие. Ожидание этот «жест» съедало,
   и открытие молча блокировалось: человек нажимал, и не происходило
   ничего. На телефоне блокировка строже, поэтому там кнопка вообще
   выглядела нерабочей картинкой.

   Теперь это обычная ссылка <a href>: переход делает сам браузер, без
   участия JS, и блокировать нечего. Свежесть адреса при этом не
   потеряли — конфиг подтягивается в фоне сразу при показе экрана и
   переписывает href (см. refreshRequestLinkHref). Пока он едет,
   ссылка уже рабочая, просто с прежним адресом.
   ================================================================ */

/* Собирает адрес заявки. kind: 'first' — первое обращение,
   'keylocked' — ключ не подошёл, 'blocked' — доступ закрыли. */
function buildRequestUrl(kind, name) {
  if (siteConfig.adminTelegramGroup) return siteConfig.adminTelegramGroup;
  if (!siteConfig.adminTelegram) return null;
  var text = (kind === 'blocked') ? buildBlockedRequestText(name)
    : (kind === 'keylocked') ? buildKeyLockedRequestText(name)
    : buildAccessRequestText(name);
  return 'https://t.me/' + encodeURIComponent(siteConfig.adminTelegram) + '?text=' + encodeURIComponent(text);
}

/* Разметка ссылки-заявки. Если администратор ещё не указал Telegram,
   ссылки нет — вместо неё кнопка, которая честно об этом скажет. */
function requestLinkHtml(kind, name, label, elId) {
  var url = buildRequestUrl(kind, name);
  if (!url) {
    return '<button type="button" class="btn btn-primary btn-sm" onclick="showToast(\'⚠️ Администратор пока не указал Telegram для приёма заявок\')">' + esc(label) + '</button>';
  }
  return '<a class="btn btn-primary btn-sm" id="' + escAttr(elId) + '" href="' + escAttr(url) + '" target="_blank" rel="noopener"' +
    ' data-request-kind="' + escAttr(kind) + '" data-request-name="' + escAttr(name || '') + '">' + esc(label) + '</a>';
}

/* Фоновое обновление адреса: тянем свежий конфиг и переписываем href
   уже показанных ссылок. Нажатие в этот момент не ломается — просто
   уйдёт по прежнему адресу. */
async function refreshRequestLinkHref() {
  var ok = await syncSiteConfigFromGithub();
  if (!ok) return;
  document.querySelectorAll('a[data-request-kind]').forEach(function(a) {
    var url = buildRequestUrl(a.dataset.requestKind, a.dataset.requestName || '');
    if (url) a.href = url;
  });
}

/* Обязательный шаг перед просмотром: гость должен отправить
   администратору своё имя и код устройства в Telegram. Один экран,
   одна кнопка: показываем имя+код для копирования и сразу открываем
   Telegram по клику той же кнопки — без промежуточных "вступите в
   группу"/"отправили?"-шагов и без ожидания технического
   подтверждения доставки (это и так невозможно проверить со
   страницы). Дальше гость просто попадает на экран ожидания, который
   сам следит за одобрением.

   ВАЖНО: перед показом каждый раз заново тянем site-config.json с
   GitHub (а не берём то, что было закэшировано при загрузке страницы) —
   если администратор успел поменять юзернейм или ссылку на группу,
   гость увидит и отправит сообщение уже по новым данным. */
async function requireTelegramSend(name) {
  await syncSiteConfigFromGithub();
  if (!siteConfig.adminTelegram && !siteConfig.adminTelegramGroup) return; // администратор ничего не указал — этот шаг попросту недоступен, пропускаем

  var isGroup = !!siteConfig.adminTelegramGroup;
  await showModal({
    title: '📤 Один короткий шаг',
    message: isGroup
      ? 'Отправьте администратору своё имя и код устройства в Telegram-группе — так он сможет одобрить вам доступ. Имя и код ниже также можно скопировать по отдельности.'
      : 'Отправьте администратору это сообщение в Telegram — так он сможет одобрить вам доступ. Сообщение уже готово, останется нажать «Отправить» в Telegram. Если он не откроется сам, имя и код ниже можно скопировать и отправить любым другим способом.',
    messageHtml: buildNameCodeCopyHtml(name, getCombinedAccessCode()),
    // Telegram открывает ССЫЛКА в подвале окна, а не действие после
    // закрытия: открытие вкладки должно происходить прямо по нажатию,
    // иначе браузер (особенно на телефоне) молча его заблокирует.
    footerHtml: '<div style="text-align:center">' +
      requestLinkHtml('first', name, '📤 Открыть Telegram', 'first-request-btn') +
      '</div>',
    withInput: false,
    hideCancel: true,
    okText: 'Готово, отправил'
  });
}

/* Оставлена для совместимости со старыми вкладками, которые могли
   загрузиться до обновления: там в разметке ещё стоит onclick на неё.
   Открываем сразу, без ожидания сети, — иначе браузер заблокирует. */
function resendTelegramRequest() {
  var name = localStorage.getItem(DEVICE_NAME_KEY) || '';
  openTelegramSend(name);
}


/* Находит запись об ЭТОМ устройстве в списке участников — по коду
   устройства или (если код изменился, например из-за инкогнито) по
   отпечатку браузера. */
/* ================================================================
   ОТЗЫВ КЛЮЧА («надгробие» вместо стирания записи)
   ================================================================
   Ключ — это и есть id записи участника, поэтому раньше удаление
   просто выбрасывало её из списка. Работало это почти всегда: при
   вводе ключа сайт спрашивает GitHub API напрямую, а не отстающую
   копию с Pages, и удалённого не пускает.

   Но оставалась щель. Если API в этот момент недоступен (нет сети или
   исчерпан лимит запросов — а он общий на весь Wi-Fi заведения),
   проверка откатывается на копию с Pages. Копия отстаёт до минуты, и
   в ней удалённый ещё есть — значит в это окно уволенный сотрудник
   мог войти по старому ключу.

   Поэтому запись теперь не стирается, а помечается отозванной. Отказ
   написан в самих данных, и его видно даже в устаревшей копии — то
   есть и без работающего API. Из списков и подсчётов такие записи
   исключены, человеку они не видны, а через месяц вычищаются совсем
   (см. purgeOldRevoked) — к тому времени копия давно обновилась. */
function isRevokedRecord(p) {
  return !!(p && p.revoked);
}

var REVOKED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/* Убирает надгробия старше месяца: их работа сделана, дальше они
   только занимают место в файле. */
function purgeOldRevoked(list) {
  var now = Date.now();
  return (list || []).filter(function(p) {
    if (!isRevokedRecord(p)) return true;
    return (now - (p.revokedAt || 0)) < REVOKED_KEEP_MS;
  });
}

/* Живые участники — то, что показывается и считается. */
function activeParticipants(list) {
  return (list || []).filter(function(p) { return !isRevokedRecord(p); });
}

function findMyRecordIn(list) {
  var myId = getDeviceId();
  var myFp = getDeviceFingerprint();
  return (list || []).filter(function(p) {
    if (isRevokedRecord(p)) return false; // ключ отозван — записи для нас нет
    if (p.id === myId) return true;
    if (myFp && p.fingerprint && p.fingerprint === myFp) return true;
    return false;
  })[0] || null;
}

function getMyParticipantRecord() {
  return findMyRecordIn(participants);
}

/* Статус доступа этого устройства:
   'approved' — есть в списке участников и не заблокирован;
   'pending'  — администратор ещё не добавил (не одобрил) это устройство;
   'blocked'  — было одобрено, но потом заблокировано.
   Раньше по умолчанию доступ был открыт всем, а список участников
   служил только для последующей блокировки. Теперь наоборот: доступ
   открывается только после того, как администратор явно добавил
   человека в список — это и есть "одобрение". */
async function checkParticipantStatus() {
  if (isAdmin()) return 'approved';
  await syncParticipantsFromGithub();
  var me = getMyParticipantRecord();
  if (!me) return 'pending';
  return me.blocked ? 'blocked' : 'approved';
}

/* Ссылка "Я разработчик (владелец) — войти", которая должна быть
   доступна на ЛЮБОМ из этих неавторизованных экранов (ожидание,
   блокировка), а не только на самом первом экране знакомства —
   иначе владелец, открывший сайт с нового устройства/браузера, может
   застрять на экране ожидания без единого способа попасть в свой же
   режим администратора. Вход не зависит от статуса участника: как
   только ключ подходит, isAdmin() становится true и весь этот экран
   больше не показывается (см. вызов reload() после успеха). */
function ownerLoginLinkHtml() {
  return '<p style="margin-top:18px;padding-top:14px;border-top:1px solid var(--glass-border)">' +
    '<span onclick="ownerLoginFromGateScreen()" style="color:var(--text-muted);font-size:12px;text-decoration:underline;cursor:pointer">🔑 Я разработчик (владелец) — войти</span>' +
    '</p>';
}

async function ownerLoginFromGateScreen() {
  var loggedIn = await loginWithGithubKey();
  if (loggedIn) location.reload(); // вошли как владелец — дальше initApp откроет обычный интерфейс
}

function showBlockedScreen() {
  // Этот экран сам занимает всю страницу вместо содержимого сайта,
  // поэтому замок доступа снимаем — иначе правило gate-locked
  // (см. встроенный стиль в <head>) скрыло бы и его тоже.
  document.documentElement.classList.remove('gate-locked');
  var name = localStorage.getItem(DEVICE_NAME_KEY) || '';
  document.body.innerHTML =
    '<div style="min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;text-align:center;padding:30px">' +
      '<div>' +
        '<div style="font-size:56px;margin-bottom:16px">🔒</div>' +
        '<h2 style="font-family:var(--font-display);margin-bottom:10px">Доступ закрыт</h2>' +
        '<p style="color:var(--text-muted);max-width:320px;margin:0 auto">Если считаете, что это ошибка — обратитесь к администратору.</p>' +
        (name ? buildNameCodeCopyHtml(name, getCombinedAccessCode()) : '<p style="color:var(--text-muted);font-size:13px;margin-top:10px">Код устройства: ' + esc(getCombinedAccessCode()) + '</p>') +
        '<p style="margin-top:14px">' + requestLinkHtml('blocked', name, '📤 Запросить ключ у администратора', 'blocked-request-btn') + '</p>' +
        ownerLoginLinkHtml() +
      '</div>' +
    '</div>';
  refreshRequestLinkHref(); // адрес мог смениться уже после блокировки — обновляем в фоне
}

/* Экран ожидания одобрения. Гость уже представился (и, если настроен
   Telegram, отправил заявку) — теперь остаётся ждать, пока
   администратор добавит его код в список участников. Пока это не
   произошло, страница сама, без участия гостя, проверяет список
   каждые 3 секунды и открывает доступ, как только он появится. */
var pendingPollTimer = null;
function showPendingScreen() {
  // Этот экран сам занимает всю страницу вместо содержимого сайта,
  // поэтому замок доступа снимаем — иначе правило gate-locked
  // (см. встроенный стиль в <head>) скрыло бы и его тоже.
  document.documentElement.classList.remove('gate-locked');
  var name = localStorage.getItem(DEVICE_NAME_KEY) || '';
  var isGroupMode = !!siteConfig.adminTelegramGroup;
  var actionsHtml = requestLinkHtml('first', name, isGroupMode ? '👥 Открыть группу' : '📤 Отправить снова', 'pending-resend-btn');
  document.body.innerHTML =
    '<div style="min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;text-align:center;padding:30px">' +
      '<div>' +
        '<div style="font-size:56px;margin-bottom:16px">⏳</div>' +
        '<h2 style="font-family:var(--font-display);margin-bottom:10px">Ожидайте подтверждения администратора</h2>' +
        '<p style="color:var(--text-muted);max-width:340px;margin:0 auto 14px">' +
          (name ? esc(name) + ', вашу заявку ещё не одобрили. ' : 'Вашу заявку ещё не одобрили. ') +
          'Как только администратор добавит вас в список участников — эта страница сама откроет книгу рецептов, ничего обновлять не нужно.' +
        '</p>' +
        (name ? buildNameCodeCopyHtml(name, getCombinedAccessCode()) : '<p style="color:var(--text-muted);font-size:13px">Код устройства: ' + esc(getCombinedAccessCode()) + '</p>') +
        '<p style="color:var(--text-muted);font-size:12px;margin:10px 0 16px" id="pending-status-line">Проверяю каждые 3 секунды…</p>' +
        actionsHtml +
        '<p style="color:var(--text-muted);font-size:11px;margin-top:10px;max-width:320px;margin-left:auto;margin-right:auto">Сообщение не дошло, закрыли Telegram раньше времени или администратор сменил ссылку? Эти кнопки доступны без входа — ссылка проверяется заново перед каждым нажатием.</p>' +
        '<p style="margin-top:10px"><button type="button" class="btn btn-success btn-sm" onclick="promptEnterAccessCode()">🔗 Уже одобрили в другом браузере? Ввести код оттуда</button></p>' +
        ownerLoginLinkHtml() +
      '</div>' +
    '</div>';
  refreshRequestLinkHref(); // адрес обновится в фоне, ссылка при этом остаётся рабочей
  schedulePendingPoll();
}

function schedulePendingPoll() {
  clearTimeout(pendingPollTimer);
  pendingPollTimer = setTimeout(async function() {
    await syncParticipantsFromGithub();
    var me = getMyParticipantRecord();
    if (me && me.blocked) { showBlockedScreen(); return; }
    if (me && !me.blocked) { location.reload(); return; } // одобрили — перезагружаем, дальше initApp пройдёт как обычно
    var line = $('pending-status-line');
    if (line) line.textContent = 'Проверено ' + new Date().toLocaleTimeString('ru-RU') + ' — пока ждём. Проверяю каждые 3 секунды…';
    schedulePendingPoll();
  }, 3000);
}

var participantsFilter = 'all'; // 'all' | 'active' | 'blocked' | 'keys'

function setParticipantsFilter(f) {
  participantsFilter = f;
  renderParticipantsList();
}

function renderParticipantsList() {
  var holder = $('participants-list');
  if (!holder) return;

  // Ключи, которые администратор сгенерировал, но которыми ещё никто
  // не воспользовался (claimed === false) — это ещё не люди, поэтому
  // они не считаются ни "активными", ни участниками вообще: у них
  // своя отдельная вкладка ниже.
  // Отозванные ключи не показываем нигде: для администратора этих
  // людей больше нет, запись живёт только ради самого отказа.
  var visible = activeParticipants(participants);
  var unclaimedKeys = visible.filter(function(p) { return p.claimed === false; });
  var realParticipants = visible.filter(function(p) { return p.claimed !== false; });

  var total = realParticipants.length;
  var blockedCount = realParticipants.filter(function(p) { return p.blocked; }).length;
  var filterRow = $('participants-filter-row');
  if (filterRow) {
    filterRow.innerHTML =
      '<button class="btn btn-sm ' + (participantsFilter === 'all' ? 'btn-primary' : 'btn-ghost') + '" onclick="setParticipantsFilter(\'all\')">Все (' + (total - blockedCount) + ')</button>' +
      '<button class="btn btn-sm ' + (participantsFilter === 'active' ? 'btn-primary' : 'btn-ghost') + '" onclick="setParticipantsFilter(\'active\')">Активные (' + (total - blockedCount) + ')</button>' +
      '<button class="btn btn-sm ' + (participantsFilter === 'blocked' ? 'btn-primary' : 'btn-ghost') + '" onclick="setParticipantsFilter(\'blocked\')">🚫 Заблокированные (' + blockedCount + ')</button>' +
      '<button class="btn btn-sm ' + (participantsFilter === 'keys' ? 'btn-primary' : 'btn-ghost') + '" onclick="setParticipantsFilter(\'keys\')">🔑 Неиспользованные ключи (' + unclaimedKeys.length + ')</button>';
  }

  if (participantsFilter === 'keys') {
    if (!unclaimedKeys.length) {
      holder.innerHTML = '<p class="admin-panel-hint">Нет сгенерированных, но ещё не использованных ключей.</p>';
      return;
    }
    holder.innerHTML = unclaimedKeys.map(function(p) {
      var dateStr = p.addedAt ? new Date(p.addedAt).toLocaleDateString('ru-RU') : '';
      // Роли, выданные ключу заранее (см. generateInviteKey) — человек
      // получит их сразу при первом входе, без отдельного действия админа.
      var keyRoles = getParticipantRoles(p);
      var rolesHtml = keyRoles.length
        ? '<br>' + keyRoles.map(function(r) { return '<span class="role-badge">' + esc(roleLabel(r)) + '</span>'; }).join('')
        : '<br><span class="role-badge" style="opacity:.6">без ролей — только «Категории»</span>';
      return '<div class="participant-item">' +
        '<div style="min-width:0">' +
          '<strong>🔑 ' + esc(p.id) + '</strong>' +
          '<br><span style="font-size:12px;color:var(--text-muted)">ещё не использован' + (dateStr ? ' · создан ' + dateStr : '') + '</span>' +
          // Для какого заведения выдан ключ — у неиспользованного это
          // единственный способ понять, кому он предназначался: ролей
          // может не быть вовсе.
          ((getVenues().length > 1 && venueById(participantVenueId(p)))
            ? '<br><span class="role-badge venue-badge">' + esc(venueLabel(participantVenueId(p))) + '</span>'
            : '') +
          rolesHtml +
        '</div>' +
        '<div style="display:flex;gap:6px;min-width:0;flex-wrap:wrap">' +
          '<button class="btn btn-primary btn-sm" onclick="editParticipantRoles(\'' + escAttr(p.id) + '\')" title="Что откроется человеку сразу после входа по этому ключу">🎭 Роли</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="copyTextToClipboard(\'' + escAttr(p.id) + '\', \'📋 Ключ скопирован\')" title="Скопировать ключ, чтобы отправить человеку">📋 Копировать</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="removeParticipant(\'' + escAttr(p.id) + '\')" title="Удалить неиспользованный ключ">✕</button>' +
        '</div>' +
      '</div>';
    }).join('');
    return;
  }

  if (!realParticipants.length) {
    holder.innerHTML = '<p class="admin-panel-hint">Пока никого нет — список появится, когда кто-то введёт выданный вами ключ.</p>';
    return;
  }

  var shown = realParticipants.filter(function(p) {
    if (participantsFilter === 'blocked') return !!p.blocked;
    return !p.blocked; // и «Все», и «Активные» показывают только незаблокированных — заблокированные видны исключительно во вкладке «Заблокированные»
  });

  if (!shown.length) {
    holder.innerHTML = '<p class="admin-panel-hint">' + (participantsFilter === 'blocked' ? 'Заблокированных пока нет.' : 'Никого не найдено.') + '</p>';
    return;
  }

  var presenceAvailable = (typeof firebase !== 'undefined');
  holder.innerHTML = participantGroupsHtml(shown, presenceAvailable);
}

/* ================================================================
   НАСТРОЙКА ПРАВ
   ================================================================ */

/* Пункты списка для окна с галочками. Права идут группами
   («Рецепты», «Структура», ...) — в подсказке первого права каждой
   группы дописано её название, потому что окно показывает плоский
   список без заголовков. */
function permissionChecklist(checkedIds, baseIds) {
  var lastGroup = '';
  return PERMISSIONS.map(function(def) {
    var hint = def.hint;
    if (def.group !== lastGroup) { hint = '— ' + def.group + ' — ' + hint; lastGroup = def.group; }
    // Если известен набор роли, помечаем, что именно человек получил бы
    // и без личной настройки: так видно, что он расширяет, а что урезает.
    if (baseIds) hint += (baseIds.indexOf(def.id) !== -1) ? ' · есть у роли' : ' · нет у роли';
    return { value: def.id, label: def.label, hint: hint, checked: checkedIds.indexOf(def.id) !== -1 };
  });
}

/* Краткая сводка набора прав — для карточки в админ-панели. */
function renderAdminPermsSummary() {
  var holder = $('admin-perms-summary');
  if (!holder) return;
  var list = adminRolePermissions();
  var off = PERMISSIONS.filter(function(d) { return list.indexOf(d.id) === -1; });
  holder.innerHTML =
    '<div class="perm-summary">' +
      '<div class="perm-summary-line"><strong>Разрешено (' + list.length + '):</strong> ' +
        (list.length ? esc(list.map(function(id) { return permissionById(id).label; }).join(', ')) : '<span style="color:var(--text-muted)">ничего</span>') +
      '</div>' +
      '<div class="perm-summary-line"><strong>Закрыто (' + off.length + '):</strong> ' +
        (off.length ? esc(off.map(function(d) { return d.label; }).join(', ')) : '<span style="color:var(--text-muted)">ничего</span>') +
      '</div>' +
    '</div>';
}

async function editAdminRolePermissions() {
  if (!isDeveloper()) { showToast('🔒 Права роли настраивает только разработчик (вход по GitHub-ключу)'); return; }
  var before = adminRolePermissions();
  var picked = await showModal({
    title: '🛡 Права роли «Администратор»',
    message: 'Отметьте, что по умолчанию может администратор. Настройка действует на всех админов сети, кроме тех, кому что-то задано лично.',
    withChecklist: permissionChecklist(before),
    okText: '💾 Сохранить'
  });
  if (picked === null) return;

  siteConfig.adminPermissions = picked;
  saveSiteConfigLocal();
  renderAdminPermsSummary();
  applyPermissionVisibility();
  showToast('⏳ Сохраняю...');
  var ok = await syncSiteConfigToGithub();
  if (ok) {
    logActivity('изменил права роли «Администратор»', 'Настройки', 'разрешено ' + picked.length + ' из ' + PERMISSIONS.length);
    showToast('✅ Права роли сохранены (' + picked.length + ' из ' + PERMISSIONS.length + ')');
  }
}

/* Личные права участника. Окно показывает ИТОГОВЫЙ набор человека, а
   разница с ролью вычисляется при сохранении: отмеченное сверх роли
   становится личным разрешением, снятое из роли — личным запретом.
   Так «расширить» и «ограничить» делаются одним и тем же понятным
   действием, а не двумя отдельными списками. */
/* Принудительное переименование участника.
   Имя человек вписывает сам при первом входе, и там бывает «ккк»,
   «айфон» или пусто. Для администратора список превращается в набор
   загадок, поэтому имя можно поправить — оно и так нужно только ему.
   Устройство после этого имя не перезапишет: с него оно берётся лишь
   при первой активации ключа (см. requireAccessKey). */
async function renameParticipant(id) {
  if (!can('participant.roles')) { denyToast('participant.roles'); return; }
  var p = participants.filter(function(x) { return x.id === id; })[0];
  if (!p) { showToast('⚠️ Участник не найден'); return; }

  var was = p.name || '';
  var name = await showModal({
    title: '✏️ Имя участника',
    message: was
      ? 'Как этот человек будет называться в списке. Он сам своё имя не увидит и менять его не сможет.'
      : 'Человек ещё не вписал имя. Укажите, как его называть в списке.',
    withInput: true,
    inputValue: was,
    placeholder: 'Имя и фамилия',
    requireInput: true,
    minInputLength: 2,
    okText: '💾 Сохранить'
  });
  if (name === null) return;

  name = name.trim().replace(/\s+/g, ' ');
  if (name === was) return;

  p.name = name;
  saveParticipantsLocal();
  renderParticipantsList();
  showToast('⏳ Сохраняю...');
  var ok = await syncParticipantsToGithub();
  if (!ok) return;
  logActivity('переименовал участника', 'Участники', (was || 'без имени') + ' → ' + name);
  showToast('✅ Теперь это «' + name + '»');
}

async function editParticipantPermissions(id) {
  if (!isDeveloper()) { showToast('🔒 Личные права настраивает только разработчик (вход по GitHub-ключу)'); return; }
  var p = participants.filter(function(x) { return x.id === id; })[0];
  if (!p) return;

  // Набор роли берём тот, что действует у человека: у главного админа
  // это всё кроме GitHub, у админа точки — набор роли «Администратор».
  var base;
  if (isSuperAdmin(p)) base = superAdminPermissions();
  else if (getParticipantRoles(p).some(function(r) { return r === 'admin' || r.indexOf('admin:') === 0; })) base = adminRolePermissions();
  else base = [];
  var before = participantPermissions(p);
  var who = p.name || ('ключ ' + p.id);

  var picked = await showModal({
    title: '🛡 Права — ' + who,
    message: (base.length
      ? 'Отмечено то, что человек может сейчас. Роль «Администратор» даёт ему набор по умолчанию — снимите лишнее или добавьте недостающее, это сохранится лично для него.'
      : 'У человека нет роли «Администратор», поэтому по умолчанию он ничего не меняет. Можно выдать отдельные права лично — например только правку закупки.'),
    withChecklist: permissionChecklist(before, base),
    okText: '💾 Сохранить'
  });
  if (picked === null) return;

  // Личные надстройки — это ровно разница с набором роли. Храним именно
  // разницу, а не итог: тогда изменение прав роли само подхватится
  // всеми, кому лично ничего не меняли.
  var allow = picked.filter(function(x) { return base.indexOf(x) === -1; });
  var deny = base.filter(function(x) { return picked.indexOf(x) === -1; });

  if (allow.length || deny.length) p.perms = { allow: allow, deny: deny };
  else delete p.perms; // ничего личного не осталось — не засоряем запись

  saveParticipantsLocal();
  showToast('⏳ Сохраняю...');
  var ok = await syncParticipantsToGithub();
  if (!ok) return;
  renderParticipantsList();
  applyPermissionVisibility();
  logActivity('изменил личные права', 'Участники', who + ': ' +
    (allow.length ? 'открыто ' + allow.map(function(x) { return permissionById(x).label; }).join(', ') : '') +
    (allow.length && deny.length ? '; ' : '') +
    (deny.length ? 'закрыто ' + deny.map(function(x) { return permissionById(x).label; }).join(', ') : '') +
    (!allow.length && !deny.length ? 'сброшено к роли' : ''));
  showToast(allow.length || deny.length
    ? '✅ Права сохранены: +' + allow.length + ', −' + deny.length + ' к роли'
    : '✅ Личные права убраны — действует роль');
}

/* ================================================================
   УЧАСТНИКИ ПО ЗАВЕДЕНИЯМ
   ================================================================
   Люди в списке перемешаны по всей сети, и найти нужного становится
   тем труднее, чем больше точек. Поэтому список собирается группами:
   «👥 Участники Route 20», «👥 Участники Римских пекарен» и так далее.
   Группа сворачивается и разворачивается нажатием на заголовок.

   К какому заведению относится человек, определяем по его ролям:
   роль вкладки указывает на раздел, раздел — на заведение; роль
   закупки указывает на заведение напрямую. Человек с ролями в двух
   точках попадает в обе группы — это не ошибка, а именно то, как он и
   работает (в бейджах ролей видно, какие вкладки где).
   ================================================================ */
var participantGroupsOpen = null; // ключ группы -> развёрнута ли
const PARTICIPANT_GROUPS_KEY = 'r20_participant_groups';

function loadParticipantGroupsState() {
  if (participantGroupsOpen) return participantGroupsOpen;
  participantGroupsOpen = {};
  try {
    var raw = localStorage.getItem(PARTICIPANT_GROUPS_KEY);
    var parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') participantGroupsOpen = parsed;
  } catch (e) {}
  return participantGroupsOpen;
}

/* По умолчанию раскрыта только группа заведения, в котором человек
   сейчас работает: остальные точки ему в этот момент не нужны, а
   длинный список пришлось бы прокручивать. */
function isParticipantGroupOpen(key) {
  var state = loadParticipantGroupsState();
  if (Object.prototype.hasOwnProperty.call(state, key)) return !!state[key];
  return key === 'venue:' + currentVenueId();
}

function toggleParticipantGroup(key) {
  var state = loadParticipantGroupsState();
  state[key] = !isParticipantGroupOpen(key);
  try { localStorage.setItem(PARTICIPANT_GROUPS_KEY, JSON.stringify(state)); } catch (e) {}
  renderParticipantsList();
}

/* Заведения, к которым относится участник (по его ролям). */
function participantVenueIds(p) {
  var out = [];
  // Заведение ключа — само по себе принадлежность к точке: у только что
  // выданного ключа ролей может ещё не быть, но в списке он должен
  // лежать в своей группе, а не в «Без ролей».
  var keyVenue = participantVenueId(p);
  if (venueById(keyVenue) && p && p.venue) out.push(keyVenue);
  getParticipantRoles(p).forEach(function(role) {
    var venue = null;
    if (role.indexOf('tab:') === 0) {
      var s = sectionById(role.slice('tab:'.length));
      if (s) venue = sectionVenueId(s);
    } else if (role === 'purchase' || role === 'admin') {
      venue = fallbackVenueId(); // старые роли без уточнения — первая точка
    } else if (role.indexOf('purchase:') === 0) {
      venue = role.slice('purchase:'.length);
    } else if (role.indexOf('admin:') === 0) {
      venue = role.slice('admin:'.length);
    }
    if (venue && venueById(venue) && out.indexOf(venue) === -1) out.push(venue);
  });
  return out;
}

/* Раскладывает участников по группам. Администраторы идут отдельной
   группой сверху: их роль действует во всех точках сразу, и повторять
   их в каждой группе значило бы раздувать список. */
function groupParticipantsByVenue(list) {
  var groups = [];
  // Отдельной группой — только главные админы: их роль действует во всех
  // точках сразу. Админ конкретного заведения показывается в группе
  // своего заведения, рядом с его же сотрудниками.
  var supers = list.filter(function(p) { return isSuperAdmin(p); });
  if (supers.length) {
    groups.push({ key: 'admins', label: '⭐ Главные администраторы', hint: 'доступ во всех заведениях', items: supers });
  }

  getVenues().forEach(function(v) {
    var items = list.filter(function(p) {
      if (isSuperAdmin(p)) return false; // уже в группе выше
      return participantVenueIds(p).indexOf(v.id) !== -1;
    });
    groups.push({
      key: 'venue:' + v.id,
      label: '👥 Участники ' + ((v.icon ? v.icon + ' ' : '') + v.label),
      hint: '',
      items: items
    });
  });

  // Люди без ролей — обычно только что вошли по ключу. Их нельзя терять:
  // именно им чаще всего и нужно что-то выдать.
  var noRoles = list.filter(function(p) {
    return !isSuperAdmin(p) && participantVenueIds(p).length === 0;
  });
  if (noRoles.length) {
    groups.push({ key: 'no-venue', label: '🕓 Без ролей', hint: 'ещё ничего не выдано', items: noRoles });
  }
  return groups;
}

function participantGroupsHtml(list, presenceAvailable) {
  var groups = groupParticipantsByVenue(list);
  return groups.map(function(g) {
    var open = isParticipantGroupOpen(g.key);
    return '<div class="participants-group' + (open ? ' is-open' : '') + '">' +
      '<button type="button" class="participants-group-head" onclick="toggleParticipantGroup(\'' + escAttr(g.key) + '\')">' +
        '<span class="participants-group-caret">▸</span>' +
        '<span class="participants-group-title">' + esc(g.label) + '</span>' +
        '<span class="participants-group-count">' + g.items.length + '</span>' +
      '</button>' +
      (open
        ? '<div class="participants-group-body">' +
            (g.items.length
              ? g.items.map(function(p) { return participantItemHtml(p, presenceAvailable); }).join('')
              : '<p class="admin-panel-hint">' + esc(g.hint ? 'Пока никого · ' + g.hint : 'Пока никого в этом заведении') + '</p>') +
          '</div>'
        : '') +
    '</div>';
  }).join('');
}

/* Разметка одной строки участника. Вынесена из renderParticipantsList,
   чтобы список можно было собирать группами по заведениям, не дублируя
   её. */
function participantItemHtml(p, presenceAvailable) {
  {
    var dateStr = p.addedAt ? new Date(p.addedAt).toLocaleDateString('ru-RU') : '';
    var myRoles = getParticipantRoles(p);
    var isRoleAdmin = myRoles.some(function(r) { return r === 'admin' || r.indexOf('admin:') === 0 || r === SUPERADMIN_ROLE; });
    var isRolePurchase = myRoles.some(function(r) { return r === 'purchase' || r.indexOf('purchase:') === 0; });
    // Бейджи всех выданных ролей — включая роли дополнительных вкладок.
    // Название роли вкладки берётся из самой вкладки (см. roleLabel),
    // поэтому переименование вкладки сразу видно и здесь.
    var rolesHtml = myRoles.length
      ? '<br>' + myRoles.map(function(r) { return '<span class="role-badge">' + esc(roleLabel(r)) + '</span>'; }).join('')
      : '';
    // Для какого заведения выдан ключ. Важно именно у неиспользованных
    // ключей: ролей там может не быть вовсе, и иначе непонятно, кому
    // этот ключ вообще предназначался.
    var keyVenue = participantVenueId(p);
    if (getVenues().length > 1 && venueById(keyVenue)) {
      rolesHtml = '<br><span class="role-badge venue-badge">' + esc(venueLabel(keyVenue)) + '</span>' +
        (rolesHtml ? rolesHtml.replace('<br>', '') : '');
    }

    // Если человеку что-то настроено лично, это должно быть видно сразу:
    // иначе непонятно, почему у двух админов разные возможности.
    var ov = participantPermOverrides(p);
    if (ov.allow.length || ov.deny.length) {
      rolesHtml += (rolesHtml ? '' : '<br>') +
        '<span class="role-badge perm-badge" title="' + escAttr(
          (ov.allow.length ? 'Дополнительно: ' + ov.allow.map(function(x) { return permissionById(x) ? permissionById(x).label : x; }).join(', ') : '') +
          (ov.allow.length && ov.deny.length ? '\n' : '') +
          (ov.deny.length ? 'Закрыто: ' + ov.deny.map(function(x) { return permissionById(x) ? permissionById(x).label : x; }).join(', ') : '')
        ) + '">🛡 личные права' +
        (ov.allow.length ? ' +' + ov.allow.length : '') +
        (ov.deny.length ? ' −' + ov.deny.length : '') + '</span>';
    }
    var itemClass = 'participant-item' + (isRoleAdmin ? ' is-admin' : '') + (isRolePurchase && !isRoleAdmin ? ' is-purchase' : '') + (p.blocked ? ' is-blocked' : '');
    // Статус "онлайн" берём из того же источника, что и вкладка "Онлайн" —
    // Firebase presence (см. subscribeOnlineUsers): её id совпадает с id
    // участника (см. requireAccessKey — после входа id устройства = ключ).
    // Поэтому статус здесь и там всегда согласован, это одни и те же данные.
    var presenceEntry = onlineUsers[p.id];
    var isLive = presenceAvailable && isOnlineLive(presenceEntry);
    var statusHtml = '';
    if (presenceAvailable) {
      var statusText = isLive ? 'на сайте сейчас' : (presenceEntry ? 'был(а) ' + formatTimeAgo(presenceEntry.lastSeen) : 'офлайн');
      statusHtml = '<span class="online-dot' + (isLive ? ' is-live' : '') + '" title="' + escAttr(statusText) + '"></span>' +
        '<span style="font-size:12px;color:' + (isLive ? 'var(--success)' : 'var(--text-muted)') + '">' + esc(statusText) + '</span>';
    }
    return '<div class="' + itemClass + '">' +
      '<div style="min-width:0">' +
        '<strong>' + esc(p.name) + '</strong>' +
        (p.blocked ? ' <span style="color:var(--accent);font-size:12px">· заблокирован</span>' : '') +
        rolesHtml +
        (statusHtml ? '<br>' + statusHtml : '') +
        '<br><span style="font-size:12px;color:var(--text-muted)">' + esc(p.id) + (p.fingerprint ? ' · отпечаток есть' : ' · без отпечатка (старая запись)') + (dateStr ? ' · добавлен ' + dateStr : '') + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:6px;min-width:0;flex-wrap:wrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="renameParticipant(\'' + escAttr(p.id) + '\')" title="Изменить имя в списке">✏️ Имя</button>' +
        '<button class="btn btn-primary btn-sm" onclick="editParticipantRoles(\'' + escAttr(p.id) + '\')" title="Выдать или снять роли — можно отметить сразу несколько">🎭 Роли</button>' +
        // Личные права — поверх роли. Кнопка только у разработчика: он
        // один решает, кому расширить или урезать возможности.
        (isDeveloper() ? '<button class="btn btn-ghost btn-sm" onclick="editParticipantPermissions(\'' + escAttr(p.id) + '\')" title="Расширить или ограничить возможности лично для этого человека">🛡 Права</button>' : '') +
        '<button class="btn btn-ghost btn-sm" onclick="showParticipantHistory(\'' + escAttr(p.id) + '\')" title="Что этот человек менял и когда">🧾 История</button>' +
        '<button class="btn btn-sm ' + (p.blocked ? 'btn-success' : 'btn-danger') + '" onclick="toggleParticipantBlock(\'' + escAttr(p.id) + '\')" title="' + (p.blocked ? 'Вернуть доступ' : 'Закрыть доступ, запись останется в списке') + '">' + (p.blocked ? '🔓 Открыть' : '🚫 Блок') + '</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="removeParticipant(\'' + escAttr(p.id) + '\')" title="Удалить запись насовсем — не то же самое, что блокировка">✕</button>' +
      '</div>' +
    '</div>';
  }
}

/* Окно «Роли» участника — единое место, где выдаются и снимаются все
   роли сразу: «Администратор», «Закупка» и по одной роли на каждую
   дополнительную вкладку (см. allRoleDefs). Открывается кнопкой
   «🎭 Роли» в списке участников; отмечать можно сколько угодно ролей
   за один раз, сохраняются они одним действием.

   Кто что может: обычный админ выдаёт и снимает роли вкладок и
   «Закупку», а галочка «Администратор» у него заблокирована —
   назначать и снимать администраторов по-прежнему может только
   разработчик (вход по GitHub-ключу) и каждый раз с подтверждением
   этим ключом, как было и в старой отдельной кнопке. */
async function editParticipantRoles(id) {
  if (!can('participant.roles')) { denyToast('participant.roles'); return; }
  var p = participants.filter(function(x) { return x.id === id; })[0];
  if (!p) return;

  var devMode = isDeveloper();
  var before = getParticipantRoles(p);
  // У ещё не использованного ключа имени нет — показываем сам ключ.
  var who = p.name || ('ключ ' + p.id);

  var picked = await showModal({
    title: '🎭 Роли — ' + who,
    message: p.claimed === false
      ? 'Отметьте, что откроется человеку сразу после того, как он войдёт по этому ключу. Без ролей ему будет доступна только вкладка «Категории».'
      : 'Отметьте все роли, которые должны быть у этого человека. Роль вкладки открывает доступ именно к ней: без неё вкладка у человека просто не отображается.',
    withChecklist: allRoleDefs().map(function(d) {
      var lockedAdmin = (!devMode && (d.id === SUPERADMIN_ROLE || d.id === 'admin' || d.id.indexOf('admin:') === 0));
      return {
        value: d.id,
        label: d.label,
        hint: d.hint + (lockedAdmin ? ' — меняет только разработчик' : ''),
        checked: before.indexOf(d.id) !== -1,
        disabled: lockedAdmin
      };
    }),
    okText: '💾 Сохранить'
  });
  if (picked === null) return;

  // Админской считается любая из ролей: главный админ и админ каждой
  // точки. Выдача любой из них подтверждается ключом.
  function anyAdminRole(list) {
    return list.some(function(r) { return r === 'admin' || r.indexOf('admin:') === 0 || r === SUPERADMIN_ROLE; });
  }
  var wasAdmin = anyAdminRole(before);
  var willAdmin = anyAdminRole(picked);

  if (wasAdmin !== willAdmin) {
    if (!devMode) { showToast('🔒 Назначать и снимать администраторов может только разработчик (вход по GitHub-ключу)'); return; }
    if (!willAdmin) {
      var myRecord = getMyParticipantRecord();
      if (myRecord && myRecord.id === p.id) {
        var okSelf = await customConfirm('Вы снимаете права администратора с записи, привязанной к вашему устройству. Ваш вход по GitHub-ключу при этом не пострадает. Продолжить?');
        if (!okSelf) return;
      }
    }
    // Каждое назначение или снятие админа подтверждается ключом заново —
    // чтобы никто не выдал себе лишние права, просто оказавшись рядом с
    // вашим уже разблокированным устройством.
    var confirmed = await confirmWithDeveloperKey(willAdmin ? '🔑 Подтверждение назначения' : '🔑 Подтверждение снятия прав');
    if (!confirmed) return;
  }

  setParticipantRoles(p, picked);
  renderParticipantsList();
  applyAdminUI(); // если роли поменяли самому себе — сразу пересобираем доступные вкладки
  showToast('⏳ Сохраняю...');
  var saved = await syncParticipantsToGithub();
  if (saved) {
    logActivity('изменил роли участника', 'Участники',
      (p.name || p.id) + ': ' + (picked.length ? picked.map(roleLabel).join(', ') : 'все роли сняты'));
    showToast(picked.length ? '✅ Роли сохранены' : '✅ Все роли сняты');
  }
  // при saved===false внутри syncParticipantsToGithub уже показан toast с точной причиной — не перезаписываем его

  if (!wasAdmin && willAdmin) {
    var wantsFull = await customConfirm(
      'Локальные права редактирования выданы сразу.\n\n' +
      'Хотите также подготовить для «' + who + '» отдельный GitHub-ключ, чтобы у него был ПОЛНЫЙ доступ,' +
      ' включая публикацию изменений на GitHub? Ключ нужно будет отправить ему лично (например в Telegram) —' +
      ' сайт не передаёт его автоматически и никому не показывает.'
    );
    if (wantsFull) await prepareAdminHandoffMessage(p);
  }
}

/* ================================================================
   ПЕРЕДАЧА GITHUB-КЛЮЧА НОВОМУ АДМИНУ
   ================================================================
   ВАЖНО: сайт статический и публичный — файл participants.json,
   как и recipes.json, читается без какой-либо авторизации. Поэтому
   хранить в нём реальный GitHub-токен с правом записи НЕЛЬЗЯ: это
   значило бы выложить рабочий ключ от репозитория в открытый доступ
   для кого угодно, а не только для назначенного админа.
   Вместо этого ключ вводится здесь один раз, собирается в готовое
   сообщение и копируется в буфер обмена — администратор сам
   пересылает его человеку по любому личному каналу (Telegram и т.п.).
   Сайт этот ключ нигде не сохраняет и не отправляет самостоятельно.
   Лучше всего создать для этого человека ОТДЕЛЬНЫЙ токен (в GitHub:
   fine-grained token, доступ только к этому репозиторию) — тогда его
   можно будет отозвать позже, не трогая ключи остальных админов.
   ================================================================ */
async function prepareAdminHandoffMessage(p) {
  var cfg = getGithubConfig() || {};

  var owner = await customPrompt('GitHub — владелец репозитория:', cfg.owner || '', '🔑 Ключ для «' + p.name + '» (1/3)');
  if (owner === null) return;
  owner = owner.trim();
  if (!owner) { showToast('⚠️ Нужно указать владельца репозитория'); return; }

  var repo = await customPrompt('Название репозитория:', cfg.repo || '', '🔑 Ключ для «' + p.name + '» (2/3)');
  if (repo === null) return;
  repo = repo.trim();
  if (!repo) { showToast('⚠️ Нужно указать репозиторий'); return; }

  var token = await customPrompt(
    'Введите GitHub Personal Access Token, который получит «' + p.name + '».\n\n' +
    'Рекомендуется создать для него отдельный fine-grained токен с доступом только к этому репозиторию —' +
    ' так его можно будет отозвать отдельно, не трогая остальных администраторов.',
    '', '🔑 Ключ для «' + p.name + '» (3/3)', 'password'
  );
  if (token === null) return;
  token = token.trim();
  if (!token) { showToast('⚠️ Нужно ввести ключ'); return; }

  var branch = (cfg.branch || 'main').trim() || 'main';

  var message =
    '🔑 Доступ администратора «Книги рецептов Route 20» для ' + p.name + '\n\n' +
    'Откройте сайт → нажмите значок входа (замок) в шапке → «Войти в режим администратора» и по очереди введите:\n\n' +
    '1) Владелец: ' + owner + '\n' +
    '2) Репозиторий: ' + repo + '\n' +
    '3) Ключ (token): ' + token + '\n\n' +
    '⚠️ Это личный ключ доступа к репозиторию — никому больше его не пересылайте.';

  copyTextToClipboard(message, '📋 Сообщение с ключом скопировано — отправьте его лично, например в Telegram');
}

/* Создаёт новый ключ доступа и сохраняет его в списке участников как
   "не использованный" (claimed:false, без имени) — администратор
   передаёт этот ключ человеку любым способом, а тот вводит его сам
   при первом заходе (см. requireAccessKey), после чего ключ
   привязывается к нему автоматически. */
async function generateInviteKey() {
  if (!can('participant.keys')) { denyToast('participant.keys'); return; }

  // Ключ всегда выдаётся ДЛЯ КОНКРЕТНОГО ЗАВЕДЕНИЯ. Иначе в сети из
  // нескольких точек непонятно, чей это ключ: роли-то видны, а вот
  // «кому он вообще предназначался» — нет. А главное, при закрытии
  // точки надо разом отозвать все её ключи, и без привязки понять,
  // какие именно, было бы нельзя (см. revokeVenueKeys).
  var venues = getVenues();
  var venueId = currentVenueId();
  if (venues.length > 1) {
    venueId = await customSelect(
      'Для какого заведения этот ключ? Роли ниже будут выданы в его границах, а при удалении заведения ключ перестанет действовать.',
      venues.map(function(v) { return { value: v.id, label: (v.icon ? v.icon + ' ' : '') + v.label }; }),
      currentVenueId(),
      '🔑 Новый ключ — заведение'
    );
    if (!venueId) return; // отменили выбор
  }
  // Список заведений строится из живых точек, поэтому ключ для
  // удалённого заведения создать нельзя в принципе — его просто нет
  // среди вариантов. Проверяем ещё раз на случай, если точку успели
  // удалить в другой вкладке, пока окно было открыто.
  if (!venueById(venueId)) { showToast('⚠️ Такого заведения больше нет — обновите страницу'); return; }

  var id;
  do {
    id = Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (participants.some(function(p) { return p.id === id; }));

  // Роли выбираются СРАЗУ при создании ключа и хранятся прямо в его
  // записи. Иначе человек, впервые вошедший по ключу, попадал на сайт
  // вообще без ролей — то есть без вкладки «Закупка» и без единой
  // дополнительной вкладки, — и сидел на почти пустом сайте до тех пор,
  // пока администратор отдельным действием не выдаст ему доступ.
  // При первом входе (см. requireAccessKey) роли из записи ключа
  // сохраняются как есть, так что доступ открывается сразу.
  var roles = await showModal({
    title: '🔑 Новый ключ — что откроется',
    message: 'Отметьте, что человек увидит сразу после ввода ключа. Без ролей ему будет доступна только вкладка «Категории». Изменить роли можно в любой момент и потом — кнопкой «🎭 Роли» в списке.',
    // Роли показываем только те, что относятся к выбранному заведению
    // (плюс общие) — иначе легко случайно открыть человеку чужую точку.
    withChecklist: rolesForVenue(venueId).map(function(d) {
      return { value: d.id, label: d.label, hint: d.hint, checked: false, disabled: false };
    }),
    okText: '🔑 Создать ключ'
  });
  if (roles === null) return; // отменили — ключ не создаём

  var record = { id: id, fingerprint: '', name: '', addedAt: Date.now(), blocked: false, claimed: false, venue: venueId };
  setParticipantRoles(record, roles);
  participants.push(record);
  participantsFilter = 'keys';
  renderParticipantsList();
  showToast('⏳ Сохраняю...');
  var ok = await syncParticipantsToGithub();
  if (!ok) return; // при ok===false внутри syncParticipantsToGithub уже показан toast с точной причиной

  logActivity('создал ключ доступа', venueLabel(venueId), roles.length ? roles.map(roleLabel).join(', ') : 'без ролей');

  var rolesLine = roles.length
    ? 'Сразу после входа ему будет доступно: ' + roles.map(roleLabel).join(', ') + '.'
    : 'Ролей не выдано — человек увидит только вкладку «Категории».';

  await showModal({
    title: '🔑 Ключ создан',
    message: 'Ключ заведения «' + venueLabel(venueId) + '».\n\nПередайте его человеку любым способом (голосом, в Telegram и т.п.). При первом заходе на сайт он введёт его и сразу получит доступ — одобрять его вручную не нужно.\n\n' + rolesLine,
    messageHtml: '<div style="display:flex;justify-content:center;margin:10px 0 4px">' + copyChipHtml('🔑', 'Ключ', id, '📋 Ключ скопирован') + '</div>',
    withInput: false,
    hideCancel: true,
    okText: 'Готово'
  });
}

async function addParticipantManually() {
  if (!can('participant.keys')) { denyToast('participant.keys'); return; }
  var name = await customPrompt('Как зовут участника?', '', '➕ Добавить участника (1/2)');
  if (name === null || !name.trim()) return;
  var pasted = await customPrompt(
    'Вставьте код устройства. Можно вставить прямо всё сообщение из Telegram целиком — лишний текст уберётся сам:',
    '', '➕ Добавить участника (2/2)'
  );
  if (pasted === null || !pasted.trim()) return;

  // Формат кода: XXXX-XXXX·отпечаток (отпечаток может отсутствовать у старых записей)
  var combo = pasted.match(/([A-Z0-9]{4}-[A-Z0-9]{4})\s*[·:]\s*([0-9a-f]{4,10})/i);
  var idOnly = pasted.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/i);
  if (!combo && !idOnly) {
    showToast('⚠️ Не нашёл код устройства в этом тексте (формат XXXX-XXXX)');
    return;
  }
  var id = (combo ? combo[1] : idOnly[0]).toUpperCase();
  var fingerprint = combo ? combo[2].toLowerCase() : '';

  if (participants.some(function(p) { return p.id === id; })) {
    showToast('⚠️ Участник с таким кодом уже есть в списке');
    return;
  }

  participants.push({ id: id, fingerprint: fingerprint, name: name.trim(), addedAt: Date.now(), blocked: false, role: 'viewer' });
  renderParticipantsList();
  showToast('⏳ Сохраняю...');
  var ok = await syncParticipantsToGithub();
  if (ok) showToast('✅ Участник добавлен');
  // при ok===false внутри syncParticipantsToGithub уже показан toast с точной причиной — не перезаписываем его
}

async function toggleParticipantBlock(id) {
  if (!can('participant.block')) { denyToast('participant.block'); return; }
  var p = participants.filter(function(x) { return x.id === id; })[0];
  if (!p) return;
  var willBlock = !p.blocked;
  var ok = await customConfirm(
    willBlock
      ? 'Закрыть доступ для «' + p.name + '»?\n\nОн потеряет доступ к рецептам, как только его телефон снова подключится к интернету. Остальные участники не пострадают.'
      : 'Вернуть доступ для «' + p.name + '»?'
  );
  if (!ok) return;

  p.blocked = willBlock;
  p.blockedAt = willBlock ? Date.now() : null;
  if (willBlock) participantsFilter = 'blocked'; // заблокированный сразу "переезжает" во вкладку "Заблокированные"
  renderParticipantsList();
  showToast('⏳ Сохраняю...');
  var saved = await syncParticipantsToGithub();
  if (saved && willBlock) await signalDeviceKick(id); // выкинуть сразу, а не ждать перезагрузки
  if (saved) {
    logActivity(willBlock ? 'заблокировал участника' : 'разблокировал участника', 'Участники', p.name || p.id);
    showToast(willBlock ? '🚫 Доступ закрыт' : '🔓 Доступ открыт');
  }
  // при saved===false внутри syncParticipantsToGithub уже показан toast с точной причиной — не перезаписываем его
}

async function removeParticipant(id) {
  if (!can('participant.remove')) { denyToast('participant.remove'); return; }
  var ok = await customConfirm('Удалить эту запись из списка участников?');
  if (!ok) return;
  // Помечаем запись отозванной вместо удаления — иначе в тот короткий
  // промежуток, пока копия на Pages не обновилась, старый ключ ещё
  // сработал бы (см. комментарий у isRevokedRecord).
  var victim = participants.filter(function(x) { return x.id === id; })[0];
  if (victim) {
    victim.revoked = true;
    victim.revokedAt = Date.now();
    victim.revokedBy = currentActorLabel();
  }
  participants = purgeOldRevoked(participants);
  renderParticipantsList();
  showToast('⏳ Сохраняю...');
  var saved = await syncParticipantsToGithub();
  // Раньше на этом всё и заканчивалось: запись пропадала из файла, но
  // человек продолжал пользоваться сайтом, пока сам не перезагрузит
  // вкладку. Теперь удаление действует так же, как «Выйти»: если
  // человек сейчас на сайте — его выкинет на экран входа сразу, а если
  // нет — доступ закроется при следующем открытии (фоновая проверка).
  if (saved) {
    await signalDeviceKick(id);
    logActivity('отозвал ключ доступа', 'Участники', (victim && victim.name) || id);
    showToast('🗑 Удалено — доступ закрыт');
  }
  // при saved===false внутри syncParticipantsToGithub уже показан toast с точной причиной — не перезаписываем его
}

/* ================================================================
   РЕЖИМ АДМИНИСТРАТОРА
   ================================================================
   В коде сайта НЕТ никакого пароля/PIN-кода — его тут просто не
   существует, посмотреть код страницы бесполезно. Единственный
   способ попасть в режим редактирования — ввести настоящий GitHub
   Personal Access Token. Он проверяется "живым" запросом к самому
   GitHub (есть ли доступ к репозиторию и права на запись), и только
   при успешной проверке включается режим администратора.

   Ключ хранится ИСКЛЮЧИТЕЛЬНО в localStorage браузера, в котором
   вы вошли — не в файле сайта. При выходе из режима редактирования
   ключ удаляется из этого браузера, и для следующего входа его
   нужно будет ввести заново.
   ================================================================ */
const ADMIN_KEY = 'r20_admin_mode';

/* Кроме входа по GitHub-ключу, права администратора можно выдать
   конкретному участнику из списка "Участники" (кнопка "Сделать
   админом") — тогда его устройство само распознаёт себя как админа
   по коду/отпечатку, без ввода какого-либо ключа. Такой админ может
   редактировать рецепты и работать со списком участников; но если
   ему нужна синхронизация с GitHub — он настраивает её отдельно,
   как и любой другой администратор. */
/* ================================================================
   КТО И КОГДА ИЗМЕНИЛ
   ================================================================
   На кухне работает много людей, и вопрос «кто поменял норму соли»
   возникает регулярно. Поэтому у записи сохраняется отметка: время и
   тот, кто её оставил, с указанием роли — «Админ Алексей»,
   «Главный админ Ирина», «Разработчик».

   Роль пишем словами прямо в отметку, а не вычисляем потом по
   участнику: человека могут разжаловать или удалить, а история должна
   остаться такой, какой была в момент правки.
   ================================================================ */
function currentActorLabel() {
  var me = getMyParticipantRecord();
  var name = (me && me.name) ? me.name : '';
  if (isDeveloper()) return name ? 'Разработчик ' + name : 'Разработчик';
  if (isSuperAdmin(me)) return name ? 'Главный админ ' + name : 'Главный админ';
  if (me && isAdminOfVenue(currentVenueId(), me)) return name ? 'Админ ' + name : 'Админ';
  return name || 'Участник';
}

/* Ставит отметку об изменении. Возвращает сам объект — удобно для
   цепочек. */
function stampEdit(obj, whatChanged) {
  if (!obj) return obj;
  obj.updatedAt = Date.now();
  obj.updatedBy = currentActorLabel();
  if (whatChanged) obj.updatedWhat = whatChanged;
  return obj;
}

function formatEditStamp(obj) {
  if (!obj || !obj.updatedAt) return '';
  var d = new Date(obj.updatedAt);
  if (isNaN(d.getTime())) return '';
  var when = d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  // Без «что именно» отметка отвечала только на половину вопроса:
  // видно, кто трогал, но не видно зачем.
  return 'Последнее изменение: ' + when + (obj.updatedBy ? ' · ' + obj.updatedBy : '') +
    (obj.updatedWhat ? ' · ' + obj.updatedWhat : '');
}

/* ================================================================
   ЖУРНАЛ ДЕЙСТВИЙ
   ================================================================
   Отметки «кто изменил» в самой записи мало: она отвечает только на
   вопрос «кто трогал последним», и то лишь у того объекта, который
   человек сейчас открыл. На кухне же спрашивают иначе — «кто поменял
   недельную норму муки» и «что вообще делал этот админ на прошлой
   неделе». Для этого нужен отдельный журнал.

   Журнал лежит в activity.json рядом с остальными данными и пишется
   тем же механизмом. Хранится не больше ACTIVITY_LIMIT последних
   записей: файл читают все админы при открытии панели, и он не должен
   разрастаться бесконечно.

   В записи хранится ЧТО сделано словами, а не код действия: роли и
   названия со временем меняются, а история должна остаться понятной
   такой, какой была в момент действия.
   ================================================================ */
const ACTIVITY_PATH = 'activity.json';
const ACTIVITY_LIMIT = 400;

var activityLog = [];

function loadActivityLocal() {
  try {
    var raw = localStorage.getItem('r20_activity');
    var parsed = raw ? JSON.parse(raw) : null;
    activityLog = Array.isArray(parsed) ? parsed : [];
  } catch (e) { activityLog = []; }
}

function saveActivityLocal() {
  try { localStorage.setItem('r20_activity', JSON.stringify(activityLog)); } catch (e) {}
}

async function syncActivityFromGithub() {
  try {
    var res = await fetch('./' + ACTIVITY_PATH + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return; // журнала ещё нет — первая запись его и создаст
    var data = await res.json();
    if (Array.isArray(data)) {
      activityLog = mergeActivity(data, activityLog);
      saveActivityLocal();
      if (currentTab === 'admin') renderActivityLog();
    }
  } catch (e) {
    console.warn('syncActivityFromGithub:', e);
  }
}

/* Слияние по id. Журнал пишут несколько человек сразу, и без слияния
   тот, кто сохранил вторым, стёр бы чужие записи, сделанные пока он
   работал. */
function mergeActivity(a, b) {
  var seen = {};
  var out = [];
  (a || []).concat(b || []).forEach(function(r) {
    if (!r || !r.id || seen[r.id]) return;
    seen[r.id] = true;
    out.push(r);
  });
  out.sort(function(x, y) { return (y.at || 0) - (x.at || 0); });
  return out.slice(0, ACTIVITY_LIMIT);
}

function syncActivityToGithub() {
  return queueGithubWrite('activity', async function() {
    var cfg = getGithubConfig();
    if (!cfg || !cfg.token) return false; // у обычного участника токена нет — журнал ведут те, кто пишет данные
    // Перед записью подмешиваем серверную версию: пока человек работал,
    // журнал могли пополнить в другом заведении.
    try {
      var res = await fetch('./' + ACTIVITY_PATH + '?_=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        var remote = await res.json();
        if (Array.isArray(remote)) activityLog = mergeActivity(activityLog, remote);
      }
    } catch (e) {}
    var put = await putJsonToGithub(ACTIVITY_PATH, activityLog, 'Журнал действий (' + new Date().toLocaleString('ru-RU') + ')');
    if (!put.ok) console.warn('syncActivityToGithub:', put.error);
    return put.ok;
  });
}

var activitySyncTimer = null;
function scheduleActivitySync() {
  clearTimeout(activitySyncTimer);
  // Пауза больше, чем у данных: журнал вторичен, и несколько действий
  // подряд лучше отправить одной записью файла.
  activitySyncTimer = setTimeout(function() { syncActivityToGithub(); }, 2500);
}

/* Главная функция: записать действие.
   what  — что сделано, словами и в прошедшем времени («изменил недельные нормы»)
   where — где это произошло («Закупка · Хорека», «Пицца бар»)
   details — необязательные подробности («Мука: 20 → 25 кг») */
function logActivity(what, where, details) {
  var me = getMyParticipantRecord();
  var entry = {
    id: uid(),
    at: Date.now(),
    who: currentActorLabel(),
    whoId: (me && me.id) || (isDeveloper() ? 'developer' : ''),
    venue: venueLabel(currentVenueId()),
    what: what,
    where: where || '',
    details: details || ''
  };
  activityLog = mergeActivity([entry], activityLog);
  saveActivityLocal();
  if (currentTab === 'admin') renderActivityLog();
  scheduleActivitySync();
  return entry;
}

/* Человеческое «когда»: для сегодняшних действий время, для остальных
   дата. В журнале обычно смотрят последнее, и полная дата у каждой
   строки только мешает читать. */
function formatActivityTime(at) {
  var d = new Date(at);
  if (isNaN(d.getTime())) return '';
  var now = new Date();
  var sameDay = d.toDateString() === now.toDateString();
  var yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  var time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'сегодня, ' + time;
  if (yesterday) return 'вчера, ' + time;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ', ' + time;
}

/* Отрисовка журнала в админ-панели. Фильтр по человеку хранится в
   переменной, а не в разметке: список перерисовывается при каждой
   новой записи, и выбор не должен теряться. */
var activityFilterWho = '';

function renderActivityLog() {
  // Число записей показываем и в свёрнутом виде — чтобы было понятно,
  // есть ли там вообще что смотреть.
  var countEl = $('activity-count');
  if (countEl) countEl.textContent = activityLog.length ? String(activityLog.length) : '';

  var card = $('activity-card');
  if (card && !card.classList.contains('open')) {
    var wasOpen = false;
    try { wasOpen = localStorage.getItem('r20_activity_open') === '1'; } catch (e) {}
    if (wasOpen) card.classList.add('open'); // человек оставлял её открытой — уважаем
  }

  var holder = $('activity-log-list');
  if (!holder) return;

  var list = activityLog.slice();
  if (activityFilterWho) list = list.filter(function(r) { return r.who === activityFilterWho; });

  var filterRow = $('activity-filter-row');
  if (filterRow) {
    var people = [];
    activityLog.forEach(function(r) { if (r.who && people.indexOf(r.who) === -1) people.push(r.who); });
    filterRow.innerHTML = ['<span class="chip' + (activityFilterWho ? '' : ' active') + '" onclick="setActivityFilter(\'\')">Все</span>']
      .concat(people.map(function(w) {
        return '<span class="chip' + (activityFilterWho === w ? ' active' : '') + '" onclick="setActivityFilter(\'' + escAttr(w) + '\')">' + esc(w) + '</span>';
      })).join('');
  }

  if (!list.length) {
    holder.innerHTML = '<p class="admin-panel-hint">' +
      (activityFilterWho ? 'У этого человека пока нет записей.' : 'Пока ничего не менялось — записи появятся после первого изменения.') +
      '</p>';
    return;
  }

  holder.innerHTML = list.slice(0, 60).map(function(r) {
    return '<div class="activity-item">' +
      '<div class="activity-head">' +
        '<strong>' + esc(r.who || 'Неизвестно') + '</strong>' +
        '<span class="activity-time">' + esc(formatActivityTime(r.at)) + '</span>' +
      '</div>' +
      '<div class="activity-what">' + esc(r.what) + (r.where ? ' <span class="activity-where">· ' + esc(r.where) + '</span>' : '') + '</div>' +
      (r.details ? '<div class="activity-details">' + esc(r.details) + '</div>' : '') +
    '</div>';
  }).join('') +
  (list.length > 60 ? '<p class="admin-panel-hint">Показаны последние 60 из ' + list.length + '.</p>' : '');
}

/* История сворачивается и разворачивается. По умолчанию свёрнута:
   заглядывают в неё редко — когда нужно понять, кто что поменял, — а
   места в панели занимала больше всех остальных карточек вместе. */
/* Сворачиваемая группа карточек в админ-панели. Выбор запоминается на
   устройстве: кто-то держит настройки GitHub открытыми постоянно, а
   кому-то они не нужны месяцами. */
function toggleAdminGroup(id) {
  var group = $(id);
  if (!group) return;
  var open = !group.classList.contains('open');
  group.classList.toggle('open', open);
  var head = group.querySelector('.admin-group-head');
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  try { localStorage.setItem('r20_group_' + id, open ? '1' : '0'); } catch (e) {}
}

/* Восстанавливает раскрытые группы при отрисовке панели. */
function restoreAdminGroups() {
  document.querySelectorAll('.admin-group').forEach(function(g) {
    var open = false;
    try { open = localStorage.getItem('r20_group_' + g.id) === '1'; } catch (e) {}
    g.classList.toggle('open', open);
    var head = g.querySelector('.admin-group-head');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

function toggleActivityLog() {
  var body = $('activity-body');
  var card = $('activity-card');
  if (!body || !card) return;
  var open = !card.classList.contains('open');
  card.classList.toggle('open', open);
  var btn = card.querySelector('.admin-panel-toggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  try { localStorage.setItem('r20_activity_open', open ? '1' : '0'); } catch (e) {}
  if (open) renderActivityLog();
}

function setActivityFilter(who) {
  activityFilterWho = who;
  renderActivityLog();
}

/* История одного человека — из строки участника. Показывается окном,
   чтобы не уводить со списка. */
async function showParticipantHistory(id) {
  var p = participants.filter(function(x) { return x.id === id; })[0];
  var who = p ? (p.name || p.id) : id;
  var mine = activityLog.filter(function(r) { return r.whoId === id || (p && p.name && r.who && r.who.indexOf(p.name) !== -1); });

  var html = mine.length
    ? '<div class="activity-modal-list">' + mine.slice(0, 40).map(function(r) {
        return '<div class="activity-item">' +
          '<div class="activity-head"><strong>' + esc(r.what) + '</strong>' +
          '<span class="activity-time">' + esc(formatActivityTime(r.at)) + '</span></div>' +
          (r.where ? '<div class="activity-where">' + esc(r.where) + '</div>' : '') +
          (r.details ? '<div class="activity-details">' + esc(r.details) + '</div>' : '') +
        '</div>';
      }).join('') + '</div>'
    : '<p class="admin-panel-hint">Записей пока нет.</p>';

  await showModal({
    title: '🧾 История — ' + who,
    message: mine.length ? ('Действий в журнале: ' + mine.length) : '',
    messageHtml: html,
    withInput: false,
    hideCancel: true,
    okText: 'Закрыть'
  });
}

/* ================================================================
   ПРАВА (тонкая настройка того, что можно делать)
   ================================================================
   Раньше прав было ровно два уровня: администратор и разработчик.
   Всё, что умел сайт, было жёстко приписано одному из них, и изменить
   это можно было только правкой кода. Теперь каждое изменяющее
   действие названо отдельным правом, и набор прав настраивается:

   1) Роль «Администратор» имеет набор по умолчанию — его задаёт
      разработчик в админ-панели (siteConfig.adminPermissions). Это
      «каким должен быть админ в этой сети».
   2) Любому конкретному человеку набор можно расширить или урезать —
      индивидуально, поверх роли (p.perms.allow / p.perms.deny). Так
      одному админу открывают удаление рецептов, а другому закрывают
      правку закупки, не трогая остальных.

   Разработчик (вход по GitHub-ключу) может всё и правами не
   ограничивается: иначе он мог бы случайно закрыть себе доступ к
   настройкам, которыми эти права и раздаются.
   ================================================================ */
var PERMISSIONS = [
  { id: 'recipe.add',         group: 'Рецепты',   label: '➕ Добавлять рецепты',            hint: 'Кнопка «Добавить рецепт» и сохранение нового' },
  { id: 'recipe.edit',        group: 'Рецепты',   label: '✏️ Редактировать рецепты',        hint: 'Правка уже существующих карточек' },
  { id: 'recipe.delete',      group: 'Рецепты',   label: '🗑 Удалять рецепты',              hint: 'Удаление без возможности вернуть' },
  { id: 'recipe.status',      group: 'Рецепты',   label: '🚫 Менять актуальность',          hint: 'Убрано с меню / сезонное / актуально' },
  { id: 'recipe.copy',        group: 'Рецепты',   label: '📋 Копировать в другое заведение', hint: 'Перенос карты в другую точку сети' },
  { id: 'category.manage',    group: 'Структура', label: '🏷 Управлять категориями',        hint: 'Добавление, переименование, размеры, удаление' },
  { id: 'section.manage',     group: 'Структура', label: '🗂 Управлять разделами',          hint: 'Создание, переименование и удаление вкладок' },
  { id: 'venue.manage',       group: 'Структура', label: '🏠 Управлять заведениями',        hint: 'Создание, переименование, удаление точек сети' },
  { id: 'participant.roles',  group: 'Участники', label: '🎭 Выдавать роли',                hint: 'Кроме роли «Администратор» — её меняет только разработчик' },
  { id: 'participant.block',  group: 'Участники', label: '🚫 Блокировать участников',       hint: 'Закрывать и возвращать доступ' },
  { id: 'participant.remove', group: 'Участники', label: '✕ Удалять участников',            hint: 'Удаление записи насовсем' },
  { id: 'participant.keys',   group: 'Участники', label: '🔑 Выдавать ключи доступа',       hint: 'Генерация ключей и ручное добавление людей' },
  { id: 'purchase.template',  group: 'Закупка',   label: '📝 Редактировать шаблон закупки', hint: 'Позиции, нормы, единицы, загрузка прайса' },
  { id: 'purchase.structure', group: 'Закупка',   label: '🏭 Управлять цехами и поставщиками', hint: 'Добавление, переименование, удаление, привязка' },
  { id: 'purchase.contacts',  group: 'Закупка',   label: '📇 Менять контакты и ссылки',     hint: 'Телефон, почта, сайт, ссылка для отправки' },
  { id: 'site.settings',      group: 'Сайт',      label: '⚙️ Менять настройки сайта',       hint: 'Фото шапки и фона, Telegram-ссылки' },
  { id: 'site.export',        group: 'Сайт',      label: '⬇️ Скачивать резервную копию',    hint: 'Выгрузка recipes.json' },
  // Отдельно от остальных настроек: тут ключ доступа к репозиторию.
  // Это право не получает даже главный админ — только владелец сайта.
  { id: 'site.github',        group: 'Сайт',      label: '🔑 Настройки GitHub и синхронизация', hint: 'Только разработчик — здесь ключ доступа к репозиторию' }
];

/* Права, действующие в границах одного заведения: админ Route 20 не
   должен править рецепты и закупку Римских пекарен. Остальные права
   (участники, настройки сайта) общие — их и раздают отдельно. */
const VENUE_SCOPED_PERMISSIONS = [
  'recipe.add', 'recipe.edit', 'recipe.delete', 'recipe.status', 'recipe.copy',
  'category.manage', 'section.manage', 'venue.manage',
  'purchase.template', 'purchase.structure', 'purchase.contacts'
];

/* Что может главный админ: всё, кроме GitHub. */
function superAdminPermissions() {
  return PERMISSIONS.filter(function(d) { return d.id !== 'site.github'; }).map(function(d) { return d.id; });
}

/* Набор роли «Администратор» по умолчанию — ровно то, что админы могли
   до появления этой настройки. Всё, что раньше было только у
   разработчика (разделы, заведения, ключи, удаление рецептов,
   настройки сайта), по умолчанию у админа выключено: расширять права
   должно быть осознанным решением, а не следствием обновления. */
const DEFAULT_ADMIN_PERMISSIONS = [
  'recipe.add', 'recipe.edit', 'recipe.status', 'recipe.copy',
  'category.manage',
  'participant.roles', 'participant.block', 'participant.remove',
  'purchase.template', 'purchase.structure', 'purchase.contacts'
];

function permissionById(id) {
  return PERMISSIONS.filter(function(p) { return p.id === id; })[0] || null;
}

/* Права роли «Администратор» из настроек сайта. */
function adminRolePermissions() {
  var list = siteConfig.adminPermissions;
  if (!Array.isArray(list)) return DEFAULT_ADMIN_PERMISSIONS.slice();
  return list.filter(function(id) { return !!permissionById(id); });
}

function participantPermOverrides(p) {
  var perms = p && p.perms;
  return {
    allow: (perms && Array.isArray(perms.allow)) ? perms.allow : [],
    deny: (perms && Array.isArray(perms.deny)) ? perms.deny : []
  };
}

/* Итоговый набор прав человека: база роли плюс личные добавления минус
   личные запреты. Личный запрет сильнее роли — иначе «ограничить в
   чём-то одном» было бы невозможно. */
function participantPermissions(p, venueId) {
  if (!p || p.blocked) return [];
  var venue = venueId || currentVenueId();
  var base;
  if (isSuperAdmin(p)) base = superAdminPermissions();
  else if (isAdminOfVenue(venue, p)) base = adminRolePermissions();
  else base = [];

  var ov = participantPermOverrides(p);
  var out = base.slice();
  ov.allow.forEach(function(id) {
    if (permissionById(id) && out.indexOf(id) === -1) out.push(id);
  });
  out = out.filter(function(id) { return ov.deny.indexOf(id) === -1; });

  // GitHub остаётся у владельца сайта при любых настройках: там лежит
  // ключ, которым публикуются данные всей сети.
  return out.filter(function(id) { return id !== 'site.github'; });
}

/* Главная проверка. Использовать вместо isDeveloper()/isAdmin() везде,
   где речь о конкретном действии, а не об общем режиме редактирования. */
function can(permId, venueId) {
  if (isDeveloper()) return true; // владелец сайта не ограничивается правами
  var me = getMyParticipantRecord();
  if (!me || me.blocked) return false;
  // Для прав, действующих в границах точки, важно, О КАКОЙ точке речь:
  // по умолчанию о той, которая сейчас открыта.
  var venue = (VENUE_SCOPED_PERMISSIONS.indexOf(permId) !== -1)
    ? (venueId || currentVenueId())
    : currentVenueId();
  return participantPermissions(me, venue).indexOf(permId) !== -1;
}

/* Единое сообщение при отказе — чтобы человек понимал, что дело в
   правах, и знал, к кому идти. */
function denyToast(permId) {
  var def = permissionById(permId);
  showToast('🔒 Нет права' + (def ? ': ' + def.label.replace(/^\S+\s/, '') : '') + ' — попросите разработчика открыть его');
}

/* Показывает и прячет элементы интерфейса по правам. У элемента стоит
   data-perm="<право>" — он виден, только если человек в режиме
   редактирования И это право у него есть. Так кнопки не приходится
   расставлять по CSS-классам ролей: право одно, место одно. */
function applyPermissionVisibility() {
  var editing = isAdmin();
  document.querySelectorAll('[data-perm]').forEach(function(el) {
    var allowed = editing && can(el.getAttribute('data-perm'));
    el.style.display = allowed ? '' : 'none';
  });
}

/* Роль администратора теперь привязана к заведению: 'admin:<venueId>'.
   Старая роль 'admin' без уточнения означает первую точку — так уже
   выданные роли продолжают работать без переделки участников. */
function adminRoleId(venueId) {
  return (venueId === fallbackVenueId()) ? 'admin' : 'admin:' + venueId;
}

/* Главный админ. Может во всех заведениях всё, кроме того, что связано
   с самим GitHub (ключ доступа, настройки репозитория, ручная
   синхронизация) — это остаётся у владельца сайта. */
const SUPERADMIN_ROLE = 'superadmin';

function isSuperAdmin(p) {
  var rec = p || getMyParticipantRecord();
  return !!(rec && !rec.blocked && getParticipantRoles(rec).indexOf(SUPERADMIN_ROLE) !== -1);
}

/* Админ конкретного заведения (или главный админ — он админ везде). */
function isAdminOfVenue(venueId, p) {
  var rec = p || getMyParticipantRecord();
  if (!rec || rec.blocked) return false;
  var roles = getParticipantRoles(rec);
  if (roles.indexOf(SUPERADMIN_ROLE) !== -1) return true;
  // У первой точки роль исторически называется просто 'admin', но выдать
  // могли и полную форму 'admin:<id>' — принимаем обе, иначе роль,
  // выданная в новом виде, у старой точки не сработала бы.
  return roles.indexOf(adminRoleId(venueId)) !== -1 || roles.indexOf('admin:' + venueId) !== -1;
}

/* «Режим редактирования включён»: человек — админ хоть где-нибудь.
   Проверка конкретного действия идёт через can(), которая уже смотрит
   и на право, и на заведение. */
function isAdmin() {
  if (localStorage.getItem(ADMIN_KEY) === '1') return true;
  var me = getMyParticipantRecord();
  if (!me || me.blocked) return false;
  if (isSuperAdmin(me)) return true;
  return getParticipantRoles(me).some(function(r) { return r === 'admin' || r.indexOf('admin:') === 0; });
}

function isAdminByParticipantRole() {
  if (localStorage.getItem(ADMIN_KEY) === '1') return false; // это уже вход по ключу
  var me = getMyParticipantRecord();
  if (!me || me.blocked) return false;
  if (isSuperAdmin(me)) return true;
  return getParticipantRoles(me).some(function(r) { return r === 'admin' || r.indexOf('admin:') === 0; });
}

/* "Разработчик" — это именно вход по настоящему GitHub-ключу (как у вас),
   в отличие от "админа", которому права выданы через список участников
   без ввода ключа. Некоторые самые чувствительные действия (назначение
   и снятие админов, удаление участников) доступны только разработчику —
   и даже разработчику каждый раз нужно заново подтвердить их ключом,
   на случай если устройство осталось разблокированным без присмотра. */
function isDeveloper() {
  return localStorage.getItem(ADMIN_KEY) === '1';
}

/* "Закупка" — отдельная, более узкая роль участника (наравне с
   'viewer'/'admin' в поле participant.role): такой человек видит ровно
   то же, что обычный гость, ПЛЮС вкладку "Закупка" (см. .purchase-access-only
   в CSS и проверку ниже в switchTab). Права редактирования шаблона
   закупки (переименование, ссылки, позиции и т.п.) у него при этом нет —
   те остаются за isAdmin(), как и раньше. Админ/разработчик и так видят
   "Закупку" через isAdmin(), поэтому эта функция нужна только для
   отдельного, невидимого больше нигде случая — участника именно с
   ролью 'purchase'. */
function hasPurchaseAccess(venueId) {
  var v = venueId || currentVenueId();
  if (!venueHasPurchase(v)) return false; // у этой точки закупки просто нет
  if (isAdmin()) return true;
  var me = getMyParticipantRecord();
  return !!(me && !me.blocked && participantHasRole(me, purchaseRoleId(v)));
}

/* ================================================================
   ПРОВЕРКА ФЛАГА АДМИНА ПРИ ЗАГРУЗКЕ
   ================================================================
   ADMIN_KEY — это просто флаг 'r20_admin_mode'='1' в localStorage.
   Раньше он выставлялся ТОЛЬКО после успешной проверки настоящего
   GitHub-ключа (loginWithGithubKey), но сам isAdmin() потом уже
   никогда заново не проверял, что ключ всё ещё существует и рабочий —
   он просто верил флагу. Это значит, что человек, посмотревший код
   страницы, мог открыть консоль браузера и вручную выполнить
   localStorage.setItem('r20_admin_mode','1'), ничего не зная о
   настоящем ключе — и сразу увидеть весь админ-интерфейс (форму
   редактирования рецептов, список участников и т.п.), просто без
   возможности что-либо реально сохранить (сохранение отдельно бьётся
   в GitHub API и там уже отваливается из-за отсутствия/невалидности
   токена). Дополнительный побочный эффект: пока флаг стоит, человек
   пропускает ensureParticipantName()/checkParticipantStatus() (они
   оба сразу выходят при isAdmin()===true), поэтому у него никогда не
   появляется запись в participants.json — и в списке "Онлайн" его не
   видно, и заблокировать его как обычного участника нельзя.

   Эта функция вызывается один раз при загрузке страницы, ДО того как
   что-либо начинает полагаться на isAdmin(). Если флаг стоит, но
   сохранённого токена нет или GitHub его не подтверждает — флаг
   снимается, и дальше человек проходит как обычный гость: экран
   "как вас зовут", ключ доступа, попадает в participants.json и
   виден/блокируем в списке "Онлайн" как все остальные. Для настоящего
   администратора (с рабочим токеном) это просто один лишний быстрый
   запрос к GitHub при открытии страницы — доступ не меняется. */
async function verifyStoredAdminSession() {
  if (localStorage.getItem(ADMIN_KEY) !== '1') return;
  var cfg = getGithubConfig() || {};
  var valid = false;
  if (cfg.owner && cfg.repo && cfg.token) {
    try {
      var check = await verifyGithubToken(cfg.owner, cfg.repo, cfg.token);
      valid = !!(check && check.ok);
    } catch (e) {
      valid = false;
    }
  }
  if (!valid) {
    // Флаг стоял без рабочего ключа за ним — снимаем немедленно.
    localStorage.removeItem(ADMIN_KEY);
  }
}

/* Просит заново ввести GitHub-ключ, чтобы подтвердить одно конкретное
   опасное действие — по той же логике, что и обычный вход. Ключ нигде
   не сохраняется и не показывается: используется один раз для живой
   проверки на GitHub и сразу забывается. Возвращает true, если ключ
   верный, иначе показывает причину отказа и возвращает false. */
async function confirmWithDeveloperKey(title) {
  var cfg = getGithubConfig() || {};
  if (!cfg.owner || !cfg.repo) {
    showToast('⚠️ Сначала настройте владельца и репозиторий (⚙️ в разделе "Добавить")');
    return false;
  }
  var token = await customPrompt(
    'Подтвердите действие своим GitHub-ключом (тем же, каким входите как разработчик).\n' +
    'Ключ используется только для проверки и нигде не сохраняется.',
    '', title || '🔑 Подтверждение', 'password'
  );
  if (token === null) return false;
  token = token.trim();
  if (!token) { showToast('⚠️ Нужно ввести ключ'); return false; }

  showToast('⏳ Проверяю ключ на GitHub...');
  var check = await verifyGithubToken(cfg.owner, cfg.repo, token);
  if (!check.ok) { showToast('⛔ ' + check.error); return false; }
  return true;
}

function updateAddGate() {
  var locked = $('add-locked');
  var fields = $('add-form-fields');
  if (!locked || !fields) return;
  if (isAdmin()) {
    locked.style.display = 'none';
    fields.style.display = '';
    var warn = $('gh-not-configured-warning');
    if (warn) {
      var cfg = getGithubConfig();
      warn.style.display = (cfg && cfg.owner && cfg.repo && cfg.token) ? 'none' : '';
    }
  } else {
    locked.style.display = '';
    fields.style.display = 'none';
  }
}

const LOCK_ICON_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
const UNLOCK_ICON_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-2"></path></svg>';

function applyAdminUI() {
  document.body.classList.toggle('is-admin', isAdmin());
  document.body.classList.toggle('is-developer', isDeveloper());
  // Отдельная роль "Закупка" (participant.role === 'purchase') — не
  // путать с is-admin: у обычного админа/разработчика доступ и так уже
  // раскрыт через is-admin, этот класс включается только для реального
  // участника с ролью 'purchase' и открывает ему ровно вкладку "Закупка".
  var meForPurchase = getMyParticipantRecord();
  var purchaseSomewhere = !!(meForPurchase && !meForPurchase.blocked && getParticipantRoles(meForPurchase).some(function(r) {
    return r === 'purchase' || r.indexOf('purchase:') === 0;
  }));
  document.body.classList.toggle('is-purchase-role', purchaseSomewhere);
  renderSectionNavTabs(); // права изменились — пересобираем список доступных разделов
  if (!isAdmin()) purchaseTemplateEditMode = false; // выход из режима — сбрасываем и режим редактирования шаблона закупки
  var btn = $('admin-toggle-btn');
  if (btn) {
    var iconEl = btn.querySelector('.icon');
    var labelEl = btn.querySelector('.label');
    if (iconEl) iconEl.innerHTML = isAdmin() ? UNLOCK_ICON_SVG : LOCK_ICON_SVG;
    if (labelEl) labelEl.textContent = isAdmin() ? 'Выход' : 'Вход';
  }
  applyPermissionVisibility(); // кнопки и карточки — строго по правам
  updateAddGate();
  if (currentTab === 'purchase') renderPurchaseTab();
  if (currentTab === 'admin') renderAdminPanel();
}

async function toggleAdmin() {
  if (isAdmin()) {
    if (isAdminByParticipantRole()) {
      // Права выданы через список участников (без GitHub-ключа) — по кнопке
      // "Выход" такой админ должен именно выйти: потерять права И полностью
      // удалиться из списка участников (а не остаться там простым viewer'ом).
      // Если понадобится доступ снова — администратор добавит его заново.
      var okLeave = await customConfirm('Выйти из режима администратора?\n\nВаши права администратора будут сняты, а запись об этом устройстве удалена из списка участников. Чтобы снова получить доступ, администратору нужно будет добавить вас заново.');
      if (!okLeave) return;
      var myRecord = getMyParticipantRecord();
      if (myRecord) {
        participants = participants.filter(function(x) { return x.id !== myRecord.id; });
        saveParticipantsLocal();
      }
      applyAdminUI();
      if (currentTab === 'add' || currentTab === 'admin' || currentTab === 'purchase') goToDefaultSection();
      showToast('⏳ Сохраняю...');
      var savedLeave = await syncParticipantsToGithub();
      if (savedLeave) showToast('🔒 Вы вышли — права сняты, запись удалена из списка участников');
      // при savedLeave===false внутри syncParticipantsToGithub уже показан toast с точной причиной — не перезаписываем его
      return;
    }
    var ok = await customConfirm('Выключить режим редактирования на этом устройстве?\n\nGitHub-ключ будет удалён из этого браузера — для следующего входа его нужно будет ввести заново.');
    if (ok) {
      localStorage.removeItem(ADMIN_KEY);
      // Удаляем сам ключ из хранилища браузера (не только флаг режима) —
      // чтобы войти снова, ключ обязательно нужно будет ввести заново.
      var cfg = getGithubConfig();
      if (cfg) {
        cfg.token = '';
        localStorage.setItem(GH_CONFIG_KEY, JSON.stringify(cfg));
      }
      applyAdminUI();
      showToast('🔒 Режим редактирования выключен, ключ удалён из браузера');
      if (currentTab === 'add' || currentTab === 'admin') goToDefaultSection();
    }
    return;
  }
  await loginWithGithubKey();
}

async function loginWithGithubKey() {
  var cfg = getGithubConfig() || {};
  var owner = (cfg.owner || '').trim();
  var repo = (cfg.repo || '').trim();
  var branch = (cfg.branch || 'main').trim();

  if (!owner) {
    var ownerInput = await customPrompt('GitHub — имя пользователя или организации:', '', '🔑 Вход в режим администратора (1/3)');
    if (ownerInput === null) return false;
    owner = ownerInput.trim();
    if (!owner) { showToast('⚠️ Нужно указать владельца репозитория'); return false; }
  }
  if (!repo) {
    var repoInput = await customPrompt('Название репозитория (например pizza):', '', '🔑 Вход в режим администратора (2/3)');
    if (repoInput === null) return false;
    repo = repoInput.trim();
    if (!repo) { showToast('⚠️ Нужно указать репозиторий'); return false; }
  }

  var token = await customPrompt(
    'Введите GitHub Personal Access Token — это и есть ключ входа.\n' +
    'Ключ нигде не хранится в коде сайта и не сохраняется у Anthropic — только в этом браузере, и он проверяется напрямую в GitHub.',
    '', '🔑 Вход в режим администратора (3/3)', 'password'
  );
  if (token === null) return false;
  token = token.trim();
  if (!token) { showToast('⚠️ Нужно ввести ключ'); return false; }

  showToast('⏳ Проверяю ключ на GitHub...');
  var check = await verifyGithubToken(owner, repo, token);
  if (!check.ok) {
    showToast('⛔ ' + check.error);
    return false;
  }

  localStorage.setItem(GH_CONFIG_KEY, JSON.stringify({ owner: owner, repo: repo, branch: branch, token: token }));
  localStorage.setItem(ADMIN_KEY, '1');
  applyAdminUI();
  showToast('🔓 Ключ подтверждён, режим администратора включён');
  return true;
}

async function verifyGithubToken(owner, repo, token) {
  try {
    var res = await fetch('https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo), {
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
    });
    if (res.status === 401) return { ok: false, error: 'Неверный ключ (не принят GitHub)' };
    if (res.status === 404) return { ok: false, error: 'Репозиторий не найден или у ключа нет к нему доступа' };
    if (!res.ok) return { ok: false, error: 'Ошибка GitHub (код ' + res.status + ')' };
    var data = await res.json();
    if (data && data.permissions && data.permissions.push === false) {
      return { ok: false, error: 'У этого ключа нет прав на запись в репозиторий' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Не удалось связаться с GitHub: ' + e.message };
  }
}

/* ================================================================
   АВТОСОХРАНЕНИЕ НА GITHUB
   ================================================================
   ЧТЕНИЕ (для ВСЕХ посетителей, без токена): при загрузке страницы
   мы просто запрашиваем recipes.json рядом с самим index.html —
   это обычный публичный файл в репозитории, GitHub Pages отдаёт
   его как статику. Никакого секрета для чтения не нужно.

   ЗАПИСЬ (только для администратора, нужен токен): чтобы сохранить
   изменения обратно в репозиторий, используется GitHub API. Токен
   хранится ТОЛЬКО в localStorage вашего браузера — он никогда не
   попадает в сам файл сайта и не виден обычным посетителям.

   Как получить токен:
   GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → New token → Repository access: только этот
   репозиторий → Permissions → Contents: Read and write.
   ================================================================ */
const GH_CONFIG_KEY = 'r20_gh_config';
const GH_DATA_PATH = 'recipes.json'; // фиксированный путь — не меняйте, иначе чтение сломается у обычных посетителей

function getGithubConfig() {
  try {
    var raw = localStorage.getItem(GH_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

async function openGithubSettings() {
  if (!can('site.settings')) { denyToast('site.settings'); return; }
  var cfg = getGithubConfig() || {};

  var owner = await customPrompt('GitHub — имя пользователя или организации:', cfg.owner || '', '⚙️ Настройка GitHub (1/4)');
  if (owner === null) return;
  var repo = await customPrompt('Название репозитория (например pizza):', cfg.repo || '', '⚙️ Настройка GitHub (2/4)');
  if (repo === null) return;
  var branch = await customPrompt('Ветка (обычно main):', cfg.branch || 'main', '⚙️ Настройка GitHub (3/4)');
  if (branch === null) return;
  var tokenInput = await customPrompt(
    'Personal Access Token (fine-grained, права "Contents: Read and write", только для этого репозитория).\n' +
    'Оставьте поле пустым, чтобы сохранить прежний токен.', '', '⚙️ Настройка GitHub (4/4)'
  );
  if (tokenInput === null) return;

  var newCfg = {
    owner: owner.trim(),
    repo: repo.trim(),
    branch: (branch || 'main').trim(),
    token: tokenInput.trim() || cfg.token || ''
  };

  if (!newCfg.owner || !newCfg.repo || !newCfg.token) {
    showToast('⚠️ Нужно указать владельца, репозиторий и токен');
    return;
  }

  localStorage.setItem(GH_CONFIG_KEY, JSON.stringify(newCfg));
  showToast('✅ Настройки сохранены. Синхронизирую...');
  syncToGithub(true);
}

function b64EncodeUnicode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

const GH_STATUS_KEY = 'r20_gh_last_sync';

/* ================================================================
   ПРОВЕРКА СОЕДИНЕНИЯ С GITHUB
   Делает настоящий тестовый запрос к API (не просто проверяет,
   заполнены ли поля) — показывает точную причину, если что-то не так:
   неверный токен, нет доступа к репозиторию, не хватает прав записи.
   ================================================================ */
async function testGithubConnection() {
  var resultEl = $('gh-test-result');
  var cfg = getGithubConfig();

  if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) {
    if (resultEl) { resultEl.textContent = '⚪ Сначала заполните настройки (⚙️ Настроить)'; resultEl.style.color = 'var(--text-muted)'; }
    return;
  }

  if (resultEl) { resultEl.textContent = '⏳ Проверяю...'; resultEl.style.color = 'var(--text-muted)'; }

  try {
    var apiUrl = 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo);
    var res = await fetchWithTimeout(apiUrl, {
      headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github+json' }
    }, 15000);

    if (res.status === 401) {
      throw new Error('Токен неверный или устарел (401). Создайте новый токен и введите заново.');
    }
    if (res.status === 404) {
      throw new Error('Репозиторий "' + cfg.owner + '/' + cfg.repo + '" не найден (404). Проверьте имя пользователя и название репозитория.');
    }
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }

    var data = await res.json();
    var perms = data.permissions || {};
    if (!perms.push) {
      throw new Error('Токен подключён, но у него нет прав на запись (Contents: Read and write). Пересоздайте токен с нужными правами.');
    }

    if (resultEl) {
      resultEl.textContent = '🟢 Всё в порядке: доступ к репозиторию "' + cfg.owner + '/' + cfg.repo + '" есть, права на запись есть.';
      resultEl.style.color = '#8fe3ac';
    }
    showToast('✅ Соединение с GitHub работает');
  } catch (e) {
    var message = (e && e.name === 'AbortError') ? 'Не удалось подключиться — истекло время ожидания. Проверьте интернет и попробуйте ещё раз.' : e.message;
    console.error('testGithubConnection error:', e);
    if (resultEl) { resultEl.textContent = '🔴 ' + message; resultEl.style.color = '#ff9aa8'; }
    showToast('⚠️ Проверка не пройдена — подробности в админ-панели');
  }
}

async function forceSyncNow() {
  if (!can('site.settings')) { denyToast('site.settings'); return; }
  var cfg = getGithubConfig();
  if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) {
    showToast('⚠️ Сначала настройте синхронизацию (⚙️ Настроить)');
    return;
  }
  showToast('⏳ Синхронизирую...');
  await syncToGithub(true); // manual=true — покажет "✅ Сохранено" или "⚠️ Ошибка" по итогу
}

/* ================================================================
   ЗАГРУЗКА ФОТО РЕЦЕПТА ОТДЕЛЬНЫМ ФАЙЛОМ НА GITHUB
   Вместо хранения фото как base64-текста внутри recipes.json,
   загружаем сжатое фото отдельным файлом в папку images/ репозитория
   и сохраняем в рецепте только короткий путь к нему. Это не даёт
   recipes.json и index.html раздуваться с каждым новым фото.
   ================================================================ */
async function uploadImageAtPath(dataUrl, path, commitMessage) {
  var cfg = getGithubConfig();
  if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) return null;

  var match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  var base64Payload = match[2];

  try {
    var apiUrl = 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + path;
    var headers = { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github+json' };

    var sha = null;
    var getRes = await fetch(apiUrl + '?ref=' + encodeURIComponent(cfg.branch), { headers: headers });
    if (getRes.status === 200) {
      var getData = await getRes.json();
      sha = getData.sha;
    } else if (getRes.status !== 404) {
      throw new Error('Проверка файла: HTTP ' + getRes.status);
    }

    var body = {
      message: commitMessage || ('Обновление фото (' + new Date().toLocaleString('ru-RU') + ')'),
      content: base64Payload,
      branch: cfg.branch
    };
    if (sha) body.sha = sha;

    var putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body)
    });

    if (!putRes.ok) {
      var errData = await putRes.json().catch(function() { return {}; });
      throw new Error(errData.message || ('HTTP ' + putRes.status));
    }

    return path;
  } catch (e) {
    console.error('uploadImageAtPath error:', e);
    return null;
  }
}

async function uploadPhotoToGithub(dataUrl, recipeId) {
  var match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  var ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  var path = 'images/' + recipeId + '.' + ext;
  return await uploadImageAtPath(dataUrl, path, 'Фото рецепта (' + new Date().toLocaleString('ru-RU') + ')');
}

function resolvePhotoSrc(photo) {
  if (!photo) return '';
  if (photo.indexOf('data:') === 0) return photo; // старые рецепты — фото прямо в данных
  return './' + photo; // новые — просто путь к отдельному файлу рядом с сайтом
}

function openPhotoLightbox(src) {
  var box = $('photo-lightbox');
  var img = $('photo-lightbox-img');
  if (!box || !img) return;
  img.src = src;
  box.classList.add('show');
}

function closePhotoLightbox() {
  var box = $('photo-lightbox');
  if (box) box.classList.remove('show');
}

/* ================================================================
   СМЕНА ФОТО ШАПКИ / ФОНА САЙТА
   Хранятся отдельными файлами: images/site-header.jpg и
   images/site-background.jpg. При загрузке страницы мы пробуем их
   подгрузить и, если они есть, подменяем ими встроенные по умолчанию.
   ================================================================ */
async function changeSitePhoto(input, kind) {
  var file = input.files[0];
  if (!file) return;
  if (!can('site.settings')) { denyToast('site.settings'); return; }

  var cfg = getGithubConfig();
  if (!cfg || !cfg.token) {
    showToast('⚠️ Сначала настройте синхронизацию с GitHub (⚙️) — иначе фото сохранится только у вас');
  }

  showToast('📤 Загружаю фото...');
  var dataUrl = await compressImage(file, { maxWidth: 1400, quality: 0.82 });
  var path = 'images/site-' + kind + '.jpg';
  applySitePhoto(kind, dataUrl); // применяем сразу, не дожидаясь ответа GitHub

  var uploaded = await uploadImageAtPath(dataUrl, path, 'Фото ' + (kind === 'header' ? 'шапки' : 'фона') + ' (' + new Date().toLocaleString('ru-RU') + ')');
  if (uploaded) {
    showToast('✅ Фото ' + (kind === 'header' ? 'шапки' : 'фона') + ' обновлено для всех посетителей');
  } else {
    showToast('⚠️ Фото применено только у вас — не удалось сохранить на GitHub');
  }
}

function applySitePhoto(kind, dataUrl) {
  if (kind === 'header') {
    var header = document.querySelector('.header');
    if (header) {
      header.style.backgroundImage =
        'linear-gradient(180deg, rgba(10,8,10,.35) 0%, rgba(10,8,10,.55) 55%, rgba(15,12,18,.88) 100%), url(' + dataUrl + ')';
    }
  } else if (kind === 'background') {
    document.body.style.backgroundImage =
      'linear-gradient(rgba(15,12,18,.91), rgba(15,12,18,.95)), url(' + dataUrl + ')';
  }
}

async function loadCustomSitePhotos() {
  ['header', 'background'].forEach(function(kind) {
    var path = './images/site-' + kind + '.jpg';
    var img = new Image();
    img.onload = function() { applySitePhoto(kind, path); };
    img.onerror = function() { /* кастомного фото нет — остаётся встроенное по умолчанию */ };
    img.src = path + '?v=' + Date.now();
  });
}

/* Обёртка над fetch с тайм-аутом — иначе на медленном интернете запрос
   к GitHub может зависнуть без вообще какой-либо ошибки. */
function fetchWithTimeout(url, opts, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs || 20000);
  return fetch(url, Object.assign({}, opts, { signal: controller.signal }))
    .finally(function() { clearTimeout(timer); });
}

/* Синхронизации ставятся в очередь, а не запускаются параллельно —
   иначе два почти одновременных сохранения (например ручное "Сохранить"
   и фоновая автосинхронизация) читают одну и ту же версию файла (sha),
   и второй PUT-запрос GitHub отклоняет как устаревший (409 Conflict).
   Это и есть самая частая причина "иногда падает синхронизация". */
var ghSyncChain = Promise.resolve();
function syncToGithub(manual) {
  var run = ghSyncChain.then(function() { return doSyncToGithub(manual); });
  ghSyncChain = run.catch(function() {}); // ошибка одного шага не должна блокировать очередь навсегда
  return run;
}

async function doSyncToGithub(manual, isRetry) {
  var cfg = getGithubConfig();
  if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) {
    if (manual) showToast('⚠️ GitHub-синхронизация не настроена (кнопка ⚙️ в разделе "Добавить")');
    return;
  }

  try {
    var apiUrl = 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + GH_DATA_PATH;
    var headers = { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github+json' };

    var sha = null;
    // no-store + метка времени в URL — иначе браузер может отдать закэшированный
    // (устаревший) ответ на этот GET, и тогда даже повтор после 409 получит
    // тот же самый устаревший sha и снова упадёт с той же ошибкой.
    var getRes = await fetchWithTimeout(apiUrl + '?ref=' + encodeURIComponent(cfg.branch) + '&_=' + Date.now(), { headers: headers, cache: 'no-store' }, 20000);
    if (getRes.status === 200) {
      var getData = await getRes.json();
      sha = getData.sha;
    } else if (getRes.status === 401) {
      throw new Error('Токен неверный или устарел (401). Обновите его в настройках синхронизации.');
    } else if (getRes.status !== 404) {
      throw new Error('Проверка файла: HTTP ' + getRes.status);
    }

    var body = {
      message: 'Обновление рецептов (' + new Date().toLocaleString('ru-RU') + ')',
      content: b64EncodeUnicode(JSON.stringify(recipes, null, 2)),
      branch: cfg.branch
    };
    if (sha) body.sha = sha;

    var putRes = await fetchWithTimeout(apiUrl, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body)
    }, 20000);

    if (putRes.status === 409 && !isRetry) {
      // Кто-то (или фоновая синхронизация чуть раньше) успел записать файл
      // между нашим GET и PUT — забираем актуальный sha и пробуем ещё раз,
      // один раз, без участия пользователя.
      return doSyncToGithub(manual, true);
    }

    if (!putRes.ok) {
      var errData = await putRes.json().catch(function() { return {}; });
      throw new Error(errData.message || ('HTTP ' + putRes.status));
    }

    localStorage.setItem(GH_STATUS_KEY, JSON.stringify({ ok: true, time: Date.now() }));
    dataSource = 'github'; // то, что сейчас в recipes[], только что успешно опубликовано — это и есть актуальные данные
    if (manual) showToast('✅ Сохранено на GitHub');
  } catch (e) {
    var message = (e && e.name === 'AbortError') ? 'Не удалось подключиться — истекло время ожидания. Проверьте интернет и попробуйте ещё раз.' : (e.message || String(e));
    console.error('GitHub sync error:', e);
    localStorage.setItem(GH_STATUS_KEY, JSON.stringify({ ok: false, time: Date.now(), error: message }));
    showToast('⚠️ Не удалось сохранить на GitHub: ' + message);
  }
  if (currentTab === 'admin') renderAdminPanel();
}

var dataSource = 'local'; // 'github' | 'local' — откуда реально загружены показанные сейчас данные

/* Предупреждает, когда свежие рецепты получить не удалось. Молчать
   тут нельзя: без SEED_RECIPES человек увидит либо старый кэш, либо
   пустой список — и должен понимать, что это сбой связи, а не то, что
   рецепты кто-то удалил. */
function warnRecipesNotLoaded() {
  if (recipes.length) {
    showToast('⚠️ Не удалось получить свежие рецепты — показана копия с этого устройства. Обновите страницу.');
  } else {
    showToast('⚠️ Рецепты не загрузились. Проверьте интернет и обновите страницу.');
  }
}

async function syncFromGithub() {
  try {
    var res = await fetch('./' + GH_DATA_PATH + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) {
      // 404 — либо файла рецептов на сервере ещё нет (новый сайт), либо
      // копия на Pages отстала. Любой другой код — связи нет, и в памяти
      // осталась локальная копия: публиковать её поверх нельзя
      // (решение принимает canPublishRecipes).
      dataSource = (res.status === 404) ? 'missing' : 'local';
      if (!(dataSource === 'missing' && !hadLocalRecipesAtStart)) warnRecipesNotLoaded();
      return;
    }
    var data = await res.json();
    if (Array.isArray(data)) {
      recipes = data;
      dataSource = 'github';
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes)); } catch(e) {}
      refreshAllSectionLists();
      if (currentTab === 'admin') renderAdminPanel();
    } else {
      // Файл есть, но внутри не список — считаем данные неполученными,
      // иначе публикация затёрла бы сервер локальной копией.
      dataSource = 'local';
      warnRecipesNotLoaded();
    }
  } catch (e) {
    // Сюда попадаем при обрыве связи или при открытии файла с диска
    // (file:// запрещает fetch). Данных с сервера нет.
    console.warn('syncFromGithub: используются локальные данные', e);
    warnRecipesNotLoaded();
  }
}

/* ================================================================
   ЭКСПОРТ — резервная копия recipes.json (только для разработчика)
   ================================================================
   Раньше кнопка пыталась скачать index.html со «запечённой» внутрь
   константой SEED_RECIPES. Работать это перестало, когда логику
   вынесли в отдельный app.js: в HTML страницы искомой константы уже
   нет, поэтому появлялось «Не удалось найти место для вставки данных».
   Восстанавливать тот механизм смысла нет — данные давно живут в
   recipes.json. Поэтому кнопка делает то, ради чего она реально
   нужна: сохраняет текущую базу отдельным файлом, чтобы её можно было
   положить в надёжное место или вручную залить в репозиторий.
   ================================================================ */
function exportSnapshot() {
  if (!can('site.export')) { denyToast('site.export'); return; }
  if (!recipes.length) { showToast('⚠️ Список пуст — нечего сохранять'); return; }

  // Резервную копию имеет смысл делать только с настоящих данных.
  // Если сервер прочитать не удалось, в памяти лежит копия этого
  // устройства — она может быть старее серверной, и человек, залив её
  // обратно, потерял бы чужие рецепты.
  if (dataSource !== 'github') {
    showToast('⚠️ Свежие данные с GitHub не получены — копия может быть неполной. Обновите страницу и повторите.');
    return;
  }

  try {
    var json = JSON.stringify(recipes, null, 2);
    var blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = GH_DATA_PATH; // именно recipes.json — файл можно залить в репозиторий как есть
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 5000);

    showToast('✅ Сохранено рецептов: ' + recipes.length + ' — файл ' + GH_DATA_PATH);
  } catch (e) {
    console.error(e);
    showToast('⚠️ Ошибка: ' + e.message);
  }
}

/* ================================================================
   TAB NAVIGATION
   ================================================================ */
let currentTab = '';

function switchTab(name) {
  if (name === currentTab) return;
  // Запоминаем последний открытый раздел — по нему кнопка «Рецепты»
  // в нижней панели возвращает человека туда, где он работал.
  if (currentTab.indexOf('section:') === 0) lastSectionTab = currentTab;
  // Создавать НОВЫЙ рецепт "с нуля" может только настоящий разработчик
  // (вход по GitHub-ключу). Обычный админ (права выданы через список
  // "Участники") может только редактировать уже существующие карточки —
  // попасть на вкладку "add" в чистом (не редактируемом) состоянии ему
  // нельзя. Заход в режиме редактирования (editingRecipe уже установлен
  // из editFromDetail ДО вызова switchTab) этим правилом не затрагивается.
  if (name === 'add' && !isAdmin()) {
    showToast('🔒 Добавлять и редактировать рецепты могут администратор и разработчик');
    return;
  }
  if (name === 'purchase' && !hasPurchaseAccess()) {
    showToast('🔒 Вкладка «Закупка» доступна только администратору и участникам с ролью «Закупка»');
    return;
  }
  // У каждого раздела своя роль — без неё он не открывается, даже если
  // кто-то попробует вызвать switchTab напрямую.
  if (name.indexOf('section:') === 0 && !hasSectionAccess(name.slice('section:'.length))) {
    showToast('🔒 Этот раздел доступен только участникам с его ролью');
    return;
  }
  if (location.hash.indexOf('#recipe=') === 0) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const tabEl = document.querySelector('.nav-tab[data-tab="' + name + '"]');
  if (tabEl) tabEl.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const contentEl = document.getElementById('tab-' + name);
  if (contentEl) contentEl.classList.add('active');

  var leavingAdmin = (currentTab === 'admin' && name !== 'admin');
  currentTab = name;
  if (leavingAdmin) unsubscribeOnlineUsers(); // не держим лишний канал открытым вне админ-панели

  if (name.indexOf('section:') === 0) {
    var openedSection = name.slice('section:'.length);
    renderCategoryChipRows();
    renderSectionList(openedSection);
    renderSectionCategoriesAdmin(openedSection);
  }
  if (name === 'admin') {
    renderAdminPanel(); renderParticipantsList(); updateTelegramConfigField();
    syncParticipantsFromGithub().then(function() { renderParticipantsList(); renderOnlineUsersList(); });
    subscribeOnlineUsers();
    renderOnlineUsersList();
  }
  // resetForm() очищает форму И editingRecipe — вызываем её только когда
  // НЕ идёт редактирование существующего рецепта (editingRecipe ещё не
  // установлен), иначе она стёрла бы то, что editFromDetail только что
  // выставил ДО вызова switchTab('add').
  if (name === 'add') { updateAddGate(); if (isAdmin() && !editingRecipe) resetForm(); }
  if (name === 'purchase') {
    renderPurchaseTab();
    syncPurchaseFromGithub().then(function() { if (currentTab === 'purchase') renderPurchaseTab(); });
  }
  updateMobileBar();
  updateNavPicker();
}

/* ================================================================
   ФОРМА РЕЦЕПТА: В КАКОЙ РАЗДЕЛ ДОБАВЛЯЕМ
   ================================================================
   Форма одна на весь сайт, но рецепт всегда принадлежит конкретному
   разделу: список «Тип» показывает только его категории, и туда же
   человек возвращается после сохранения. Раздел задаётся кнопкой
   «➕ Добавить рецепт» внутри самого раздела (openAddForm) либо
   берётся из редактируемого рецепта (editFromDetail).
   ================================================================ */
var pendingAddSection = '';
var pendingAddType = '';

function currentFormSection() {
  if (editingRecipe) return recipeSectionId(editingRecipe);
  if (pendingAddSection && sectionById(pendingAddSection)) return pendingAddSection;
  return fallbackSectionId();
}

function openAddForm(sectionId) {
  if (!can('recipe.add')) { denyToast('recipe.add'); return; }
  pendingAddSection = (sectionId && sectionById(sectionId)) ? sectionId : fallbackSectionId();
  if (!categoriesForSection(pendingAddSection).length) {
    showToast('⚠️ Сначала создайте в этом разделе хотя бы одну категорию — кнопка «🏷️ Категории»');
    return;
  }
  pendingAddType = firstCategoryIdForSection(pendingAddSection);
  editingRecipe = null;
  switchTab('add');
}

/* Уйти из формы обратно в тот раздел, с которым работали. */
function closeAddForm() {
  editingRecipe = null;
  var target = 'section:' + currentFormSection();
  if (hasSectionAccess(currentFormSection())) switchTab(target);
  else goToDefaultSection();
}

/* Заголовок формы и подпись категории теперь берутся из самой
   категории (см. getRecipeCategories) — отдельного словаря с
   падежами больше нет: он был зашит в код и не мог знать про
   категории, добавленные пользователем. */
function categoryTitleSuffix(id) {
  var c = recipeCategoryById(id);
  if (!c) return '';
  return ' — ' + (c.icon ? c.icon + ' ' : '') + c.label;
}

function onTypeChange() {
  var sel = $('f-type');
  if (!sel) return;
  var type = sel.value;
  // Список «Размер» свой у каждой категории (диаметры у пиццы, формы
  // у кондитера, порции у горячего цеха) — см. setCategorySizes.
  var sizeEl = $('f-size');
  renderSizeSelect(type, sizeEl ? sizeEl.value : '');
  var titleEl = $('form-title');
  if (titleEl) {
    titleEl.textContent = (editingRecipe ? '✏️ Редактирование' : '➕ Новый рецепт') +
      ' · ' + sectionLabel(currentFormSection()) + categoryTitleSuffix(type);
  }
}

/* ================================================================
   SHORTCUT for getElementById
   ================================================================ */
function $(id) { return document.getElementById(id); }

/* ================================================================
   PHOTO HANDLING (compress to keep localStorage size manageable)
   ================================================================ */
let currentPhotoData = null;

function handlePhoto(input) {
  const file = input.files[0];
  if (!file) return;
  compressImage(file, {maxWidth: 600}).then(function(data) {
    currentPhotoData = data;
    $('f-photo-data').value = data;
    renderPhotoPreview(data);
  });
}

function compressImage(file, opts) {
  return new Promise(function(resolve) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const img = new Image();
      img.onload = function() {
        var c = document.createElement('canvas');
        var w = img.width, h = img.height;
        if (opts.maxWidth && w > opts.maxWidth) { h = h * opts.maxWidth / w; w = opts.maxWidth; }
        if (!opts.maxHeight || h <= opts.maxHeight) {
          c.width = w; c.height = h;
        } else {
          w = w * opts.maxHeight / h; h = opts.maxHeight;
          c.width = w; c.height = h;
        }
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', opts.quality || 0.65));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderPhotoPreview(dataUrl) {
  var area = $('photo-area');
  var fileInput = '<input type="file" accept="image/*" id="f-photo-input" style="display:none" onchange="handlePhoto(this)">';
  if (dataUrl) {
    // Кнопка удаления лежит поверх снимка. Нажатие гасим stopPropagation:
    // сама область по клику открывает выбор файла, и без этого удаление
    // тут же предлагало бы выбрать новое фото.
    area.innerHTML = '<img src="' + escAttr(resolvePhotoSrc(dataUrl)) + '" alt="Фото">' +
      '<button type="button" class="photo-remove-btn" title="Удалить фото" onclick="event.stopPropagation(); removeFormPhoto()">🗑</button>' +
      fileInput;
  } else {
    area.innerHTML = '<span class="placeholder-icon">📷</span><span class="placeholder-text">Нажмите чтобы добавить фото</span>' + fileInput;
  }
}

/* Убрать фото в форме рецепта. Само сохранение произойдёт, когда
   человек нажмёт «Сохранить», — как и с любым другим полем формы. */
function removeFormPhoto() {
  currentPhotoData = null;
  var hidden = $('f-photo-data');
  if (hidden) hidden.value = '';
  renderPhotoPreview(null);
  showToast('🗑 Фото убрано — не забудьте сохранить рецепт');
}

/* ================================================================
   INGREDIENTS & STEPS ROW MANAGEMENT
   ================================================================ */
var editingRecipe = null;

function addIngredientRow(value) {
  if (!value) value = '';
  var list = $('ingredients-list');
  var row = document.createElement('div');
  row.className = 'ingredient-row';
  row.innerHTML = '<input type="text" placeholder="Ингредиент, например: 200 г томатного соуса или 2 кг муки">' +
    '<div class="row-move-btns">' +
      '<button type="button" title="Переместить вверх" onclick="moveRow(this,\'up\')"><svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"></path></svg></button>' +
      '<button type="button" title="Переместить вниз" onclick="moveRow(this,\'down\')"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></button>' +
    '</div>' +
    '<button class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); updateMoveButtonsState(); calcWeightFromIngredients(true)">✕</button>';
  list.appendChild(row);
  if (value) row.querySelector('input').value = value;

  var input = row.querySelector('input');
  input.addEventListener('input', function() { calcWeightFromIngredients(true); });
  updateMoveButtonsState();
}

/* ================================================================
   АВТОМАТИЧЕСКИЙ ПОДСЧЁТ ОБЩЕГО ВЕСА ИЗ ИНГРЕДИЕНТОВ
   Ищет в каждой строке ингредиента число, за которым идёт "г"/"гр"
   (граммы), и суммирует. Строки без веса в граммах (например "3 шт",
   "по вкусу") просто пропускаются.
   ================================================================ */
function extractWeightGrams(text) {
  // Сначала проверяем килограммы (2кг, 1.5 кг) — переводим в граммы
  var mKg = text.match(/(\d+(?:[.,]\d+)?)\s*кг(?![а-яёa-z])/i);
  if (mKg) {
    var nKg = parseFloat(mKg[1].replace(',', '.'));
    if (!isNaN(nKg)) return nKg * 1000;
  }
  // Затем граммы (200г, 200 гр)
  var mG = text.match(/(\d+(?:[.,]\d+)?)\s*г(?:р)?(?![а-яёa-z])/i);
  if (mG) {
    var nG = parseFloat(mG[1].replace(',', '.'));
    if (!isNaN(nG)) return nG;
  }
  return null;
}

function formatWeight(grams) {
  if (grams === null || grams === undefined) return '';
  if (grams >= 1000) {
    var kg = grams / 1000;
    var rounded = Math.round(kg * 100) / 100; // до сотых, без лишних нулей
    return rounded + ' кг';
  }
  return Math.round(grams) + ' г';
}

function calcWeightFromIngredients(silent) {
  var total = 0;
  var found = false;

  document.querySelectorAll('#ingredients-list .ingredient-row input').forEach(function(inp) {
    var text = inp.value || '';
    var grams = extractWeightGrams(text);
    if (grams !== null) { total += grams; found = true; }
  });

  if (found) {
    $('f-weight').value = Math.round(total);
    if (!silent) showToast('🧮 Посчитано: ' + formatWeight(total) + ' (сумма ингредиентов)');
  } else if (!silent) {
    showToast('⚠️ Не найдено ингредиентов с весом в граммах/кг (например "200 г мука" или "2 кг мука")');
  }
}

/* ================================================================
   ВИДЕО В РЕЦЕПТЕ — универсальный разбор ссылки
   Поддерживаются: YouTube, Google Диск, Vimeo, прямая ссылка на
   видеофайл (.mp4/.webm/.mov/.ogg). Если источник не распознан —
   вместо плеера показывается обычная ссылка "Открыть видео",
   чтобы ничего не ломалось.
   ================================================================ */
function getRecipeVideos(r) {
  if (r.videos && r.videos.length) return r.videos;
  if (r.video) return [r.video]; // старые рецепты, сохранённые до появления списка видео
  return [];
}

function parseVideoUrl(url) {
  if (!url) return null;
  url = url.trim();

  // YouTube (watch, youtu.be, embed, shorts)
  var yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  var ytShorts = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (ytShorts) return { type: 'youtube', id: ytShorts[1], embedUrl: 'https://www.youtube-nocookie.com/embed/' + ytShorts[1], aspect: '9-16' };
  if (yt) return { type: 'youtube', id: yt[1], embedUrl: 'https://www.youtube-nocookie.com/embed/' + yt[1], aspect: '16-9' };

  // Google Drive (/file/d/ID/... или open?id=ID)
  var drive = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (drive) return { type: 'drive', embedUrl: 'https://drive.google.com/file/d/' + drive[1] + '/preview', aspect: '16-9' };

  // Vimeo
  var vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return { type: 'vimeo', id: vimeo[1], embedUrl: 'https://player.vimeo.com/video/' + vimeo[1], aspect: '16-9' };

  // TikTok (tiktok.com/@user/video/ID) — всегда вертикальное
  var tiktok = url.match(/tiktok\.com\/@[\w.-]+\/video\/(\d+)/);
  if (tiktok) return { type: 'tiktok', embedUrl: 'https://www.tiktok.com/embed/v2/' + tiktok[1], aspect: '9-16' };

  // Instagram — Reels вертикальные, обычные посты чаще квадратные/4:5
  var reel = url.match(/instagram\.com\/reel\/([a-zA-Z0-9_-]+)/);
  if (reel) return { type: 'instagram', embedUrl: 'https://www.instagram.com/reel/' + reel[1] + '/embed', aspect: '9-16' };
  var insta = url.match(/instagram\.com\/p\/([a-zA-Z0-9_-]+)/);
  if (insta) return { type: 'instagram', embedUrl: 'https://www.instagram.com/p/' + insta[1] + '/embed', aspect: '4-5' };

  // VK (vk.com/video-OID_ID)
  var vk = url.match(/vk\.com\/video(-?\d+)_(\d+)/);
  if (vk) return { type: 'vk', embedUrl: 'https://vk.com/video_ext.php?oid=' + vk[1] + '&id=' + vk[2], aspect: '16-9' };

  // Facebook (обычные ссылки на видео и fb.watch)
  if (/facebook\.com\/.+\/videos\/|fb\.watch\//.test(url)) {
    return { type: 'facebook', embedUrl: 'https://www.facebook.com/plugins/video.php?href=' + encodeURIComponent(url) + '&show_text=false', aspect: '16-9' };
  }

  // Прямая ссылка на видеофайл — точную ориентацию узнаем динамически после загрузки метаданных
  if (/\.(mp4|webm|mov|ogg)(\?.*)?$/i.test(url)) return { type: 'direct', embedUrl: url, aspect: '16-9' };

  return { type: 'unknown', embedUrl: url };
}

function renderVideoBlock(url, autoplay) {
  var v = parseVideoUrl(url);
  if (!v) return '';
  var ratioClass = 'ratio-' + (v.aspect || '16-9');

  if (v.type === 'direct') {
    var attrs = autoplay ? 'controls playsinline autoplay muted loop' : 'controls playsinline loop';
    return '<div class="video-embed-wrap ' + ratioClass + '">' +
      '<video src="' + escAttr(v.embedUrl) + '" ' + attrs + ' onloadedmetadata="adjustVideoAspect(this)"></video></div>';
  }

  if (v.type === 'youtube') {
    var ytParams = autoplay ? 'autoplay=1&mute=1&playsinline=1&rel=0' : 'rel=0';
    var ytUrl = v.embedUrl + '?' + ytParams;
    return '<div class="video-embed-wrap ' + ratioClass + '"><iframe src="' + escAttr(ytUrl) + '" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>'
      + '<a class="video-fallback-link" href="' + escAttr(url) + '" target="_blank" rel="noopener">Видео не загрузилось? Открыть на YouTube →</a>';
  }
  if (v.type === 'vimeo') {
    var vimeoParams = autoplay ? 'autoplay=1&muted=1&loop=1' : 'loop=1';
    var vimeoUrl = v.embedUrl + '?' + vimeoParams;
    return '<div class="video-embed-wrap ' + ratioClass + '"><iframe src="' + escAttr(vimeoUrl) + '" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>'
      + '<a class="video-fallback-link" href="' + escAttr(url) + '" target="_blank" rel="noopener">Видео не загрузилось? Открыть на Vimeo →</a>';
  }
  if (v.type === 'drive') {
    // У предпросмотра Google Диска нет параметра автовоспроизведения/повтора —
    // запускается вручную одним нажатием на Play внутри плеера.
    return '<div class="video-embed-wrap ' + ratioClass + '"><iframe src="' + escAttr(v.embedUrl) + '" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>';
  }

  // Соцсети (Instagram, VK, Facebook, TikTok) — их плееры не поддерживают
  // автовоспроизведение/повтор через ссылку, включаются нажатием Play вручную.
  // Если автор закрыл пост от показа на чужих сайтах — есть запасная ссылка.
  if (v.type === 'tiktok' || v.type === 'instagram' || v.type === 'vk' || v.type === 'facebook') {
    return '<div class="video-embed-wrap ' + ratioClass + '"><iframe src="' + escAttr(v.embedUrl) + '" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>'
      + '<a class="video-fallback-link" href="' + escAttr(url) + '" target="_blank" rel="noopener">Видео не отображается? Открыть оригинал →</a>';
  }

  // Источник не распознан — просто ссылка
  return '<a class="video-fallback-link" href="' + escAttr(url) + '" target="_blank" rel="noopener">🎬 Открыть видео →</a>';
}

function adjustVideoAspect(videoEl) {
  if (!videoEl.videoWidth || !videoEl.videoHeight) return;
  var wrap = videoEl.parentElement;
  if (!wrap) return;
  wrap.classList.remove('ratio-16-9', 'ratio-9-16', 'ratio-4-5');
  wrap.style.aspectRatio = videoEl.videoWidth + ' / ' + videoEl.videoHeight;
  if (videoEl.videoWidth < videoEl.videoHeight) {
    // Портретное видео — ограничиваем по высоте, чтобы целиком влезало на экран без прокрутки
    wrap.style.maxHeight = '68vh';
    wrap.style.width = 'auto';
    wrap.style.maxWidth = '100%';
  } else {
    wrap.style.width = '100%';
    wrap.style.maxHeight = '';
  }
}

function addStepRow(value) {
  if (!value) value = '';
  var list = $('steps-list');
  var row = document.createElement('div');
  row.className = 'step-row';
  var num = list.children.length + 1;
  row.innerHTML = '<span class="step-num">' + num + '</span>' +
    '<input type="text" placeholder="Шаг ' + num + ': ...">\n'
    + '<div class="row-move-btns">'
    +   '<button type="button" title="Переместить вверх" onclick="moveRow(this,\'up\')"><svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"></path></svg></button>'
    +   '<button type="button" title="Переместить вниз" onclick="moveRow(this,\'down\')"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></button>'
    + '</div>'
    + '<button class="btn btn-danger btn-sm" onclick="removeStep(this)">✕</button>';
  list.appendChild(row);
  if (value) row.querySelector('input').value = value;
  renumberSteps();
}

function removeStep(btn) {
  btn.closest('.step-row').remove();
  renumberSteps();
}

function renumberSteps() {
  var rows = document.querySelectorAll('#steps-list .step-row');
  updateMoveButtonsState();
  for (var i = 0; i < rows.length; i++) {
    rows[i].querySelector('.step-num').textContent = i + 1;
  }
}

/* ================================================================
   SAVE / EDIT RECIPE
   ================================================================ */
/* ================================================================
   ПЕРЕМЕЩЕНИЕ ИНГРЕДИЕНТОВ / ШАГОВ (вверх-вниз кнопками)
   Работает одинаково надёжно мышкой и пальцем на телефоне —
   в отличие от перетаскивания (drag-and-drop), которое на iPhone
   часто ведёт себя нестабильно внутри прокручиваемых форм.
   ================================================================ */
function moveRow(btn, dir) {
  var row = btn.closest('.ingredient-row, .step-row, .video-row');
  if (!row) return;
  var sibling = dir === 'up' ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;

  if (dir === 'up') row.parentNode.insertBefore(row, sibling);
  else row.parentNode.insertBefore(sibling, row);

  if (row.classList.contains('step-row')) renumberSteps();
  updateMoveButtonsState();

  var inp = row.querySelector('input');
  if (inp) inp.focus();
}

function updateMoveButtonsState() {
  ['ingredients-list', 'steps-list', 'videos-list'].forEach(function(listId) {
    var rows = document.querySelectorAll('#' + listId + ' > div');
    rows.forEach(function(row, i) {
      var upBtn = row.querySelector('.row-move-btns button:first-child');
      var downBtn = row.querySelector('.row-move-btns button:last-child');
      if (upBtn) upBtn.disabled = (i === 0);
      if (downBtn) downBtn.disabled = (i === rows.length - 1);
    });
  });
}

function addVideoRow(value) {
  if (!value) value = '';
  var list = $('videos-list');
  var row = document.createElement('div');
  row.className = 'video-row';
  row.innerHTML =
    '<div class="video-row-inputs">' +
      '<input type="text" placeholder="Вставьте ссылку на видео" oninput="previewVideoRow(this)">' +
      '<div class="row-move-btns">' +
        '<button type="button" title="Переместить вверх" onclick="moveRow(this,\'up\')"><svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"></path></svg></button>' +
        '<button type="button" title="Переместить вниз" onclick="moveRow(this,\'down\')"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></button>' +
      '</div>' +
      '<button class="btn btn-danger btn-sm" onclick="this.closest(\'.video-row\').remove(); updateMoveButtonsState()">✕</button>' +
    '</div>' +
    '<p class="video-row-hint"></p>';
  list.appendChild(row);
  if (value) row.querySelector('input').value = value;
  previewVideoRow(row.querySelector('input'));
  updateMoveButtonsState();
}

function previewVideoRow(input) {
  var url = input.value.trim();
  var hint = input.closest('.video-row').querySelector('.video-row-hint');
  if (!hint) return;
  if (!url) { hint.textContent = ''; return; }

  var v = parseVideoUrl(url);
  var labels = {
    youtube: '✅ YouTube — плеер запустится автоматически и будет повторяться по кругу.',
    drive: '✅ Google Диск — запуск вручную (Play внутри плеера).',
    vimeo: '✅ Vimeo — плеер запустится автоматически и будет повторяться по кругу.',
    tiktok: '✅ TikTok — запуск вручную.',
    instagram: '✅ Instagram — запуск вручную, только для публичных постов/Reels.',
    vk: '✅ VK — запуск вручную.',
    facebook: '✅ Facebook — запуск вручную, только для публичных видео.',
    direct: '✅ Прямая ссылка на видеофайл — автовоспроизведение по кругу.',
    unknown: '⚠️ Источник не распознан — будет показана обычная ссылка.'
  };
  hint.textContent = labels[v.type] || '';
}

function resetForm() {
  editingRecipe = null;
  renderTypeSelect(); // категории раздела могли измениться с прошлого открытия формы
  var section = currentFormSection();
  var inSection = categoriesForSection(section).some(function(c) { return c.id === pendingAddType; });
  var type = inSection ? pendingAddType : firstCategoryIdForSection(section);
  pendingAddType = type;
  $('f-type').value = type;
  renderSizeSelect(type, '');
  $('form-title').textContent = '➕ Новый рецепт · ' + sectionLabel(section) + categoryTitleSuffix(type);
  $('f-name').value = '';
  $('f-time').value = '';
  $('f-size').value = '';
  $('f-calories').value = '';
  $('f-weight').value = '';
  $('f-style').value = '';
  $('videos-list').innerHTML = '';
  $('ingredients-list').innerHTML = '';
  $('steps-list').innerHTML = '';
  currentPhotoData = null;
  $('f-photo-data').value = '';
  renderPhotoPreview(null);
  addIngredientRow();
  addStepRow();
  onTypeChange();
}

async function saveRecipe() {
  // Право проверяем по тому, что именно происходит: добавление нового
  // рецепта и правка существующего — разные права, и человеку могут
  // открыть только одно из них.
  var savePerm = editingRecipe ? 'recipe.edit' : 'recipe.add';
  if (!can(savePerm)) { denyToast(savePerm); return; }
  var name = $('f-name').value.trim();
  if (!name) { showToast('⚠️ Укажите название рецепта'); return; }

  var ingredients = [];
  document.querySelectorAll('#ingredients-list .ingredient-row input').forEach(function(inp) {
    var v = inp.value.trim();
    if (v) ingredients.push(v);
  });
  if (!ingredients.length) { showToast('⚠️ Добавьте хотя бы один ингредиент'); return; }

  var steps = [];
  document.querySelectorAll('#steps-list .step-row input').forEach(function(inp) {
    var v = inp.value.trim();
    if (v) steps.push(v);
  });
  if (!steps.length) { showToast('⚠️ Добавьте хотя бы один шаг приготовления'); return; }

  var cfg = getGithubConfig();
  if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) {
    var proceed = await customConfirm(
      'На этом устройстве не настроена синхронизация с GitHub.\n\n' +
      'Рецепт сохранится только в этом браузере и может пропасть при следующем заходе на сайт. ' +
      'Рекомендуется сначала настроить синхронизацию (⚙️).\n\n' +
      'Сохранить всё равно, только локально?',
      '⚠️ Синхронизация не настроена'
    );
    if (!proceed) return;
  }

  var videos = [];
  document.querySelectorAll('#videos-list .video-row input').forEach(function(inp) {
    var v = inp.value.trim();
    if (v) videos.push(v);
  });

  var recipeId = editingRecipe ? editingRecipe.id : uid();

  // Если фото ещё хранится как base64 (новое или старое немигрированное) —
  // пробуем перенести его отдельным файлом на GitHub, чтобы не раздувать recipes.json
  var photoValue = $('f-photo-data').value || null;
  if (photoValue && photoValue.indexOf('data:image') === 0 && cfg && cfg.token) {
    showToast('📤 Загружаю фото на GitHub...');
    var uploadedPath = await uploadPhotoToGithub(photoValue, recipeId);
    if (uploadedPath) {
      photoValue = uploadedPath;
    } else {
      showToast('⚠️ Не удалось загрузить фото отдельно — сохранено внутри рецепта, как раньше');
    }
  }

  var recipe = {
    id: recipeId,
    type: $('f-type').value || firstCategoryIdForSection(currentFormSection()),
    section: currentFormSection(),
    name: name,
    photo: photoValue,
    time: parseInt($('f-time').value) || null,
    size: $('f-size').value || null,
    calories: parseInt($('f-calories').value) || null,
    weight: parseInt($('f-weight').value) || null,
    style: $('f-style').value.trim() || null,
    // Рецепт пересобирается целиком, поэтому статус переносим явно —
    // иначе любое редактирование возвращало бы снятое блюдо в меню.
    status: editingRecipe ? recipeStatus(editingRecipe) : 'active',
    // Отметку об авторе правки ставим тут же: рецепт пересобирается
    // целиком, и без явного переноса она бы потерялась.
    updatedAt: Date.now(),
    updatedBy: currentActorLabel(),
    updatedWhat: editingRecipe ? 'отредактировал карточку' : 'создал карточку',
    videos: videos,
    ingredients: ingredients,
    steps: steps
  };

  if (editingRecipe) {
    var idx = -1;
    for (var i = 0; i < recipes.length; i++) {
      if (recipes[i].id === recipe.id) { idx = i; break; }
    }
    if (idx >= 0) recipes[idx] = recipe;
    else recipes.push(recipe);
    logActivity('изменил рецепт', sectionLabel(recipeSectionId(recipe)), recipe.name);
    showToast('✅ Рецепт обновлён');
  } else {
    recipes.push(recipe);
    logActivity('добавил рецепт', sectionLabel(recipeSectionId(recipe)), recipe.name);
    var addedCat = recipeCategoryById(recipe.type);
    showToast('✅ Рецепт добавлен' + (addedCat ? ' — ' + (addedCat.icon ? addedCat.icon + ' ' : '') + addedCat.label : '') + '!');
  }

  var saved = saveAll();
  if (!saved) return; // Could not save - abort

  resetForm();
  closeAddForm();
}

/* ================================================================
   RENDER LIST TABS (Pizza / Pinsa / Dough / Sauces)
   ================================================================ */
/* Переключатель актуальности прямо в карточке (виден только админу).
   Сделан отдельными кнопками, а не выпадающим списком: статус меняют
   на ходу, часто с телефона, и лишнее открытие списка тут только мешает.
   Клики гасятся stopPropagation — иначе нажатие проваливалось бы в
   карточку и открывало рецепт. */
function recipeStatusSwitchHtml(r) {
  // Класса admin-only мало: он лишь прячет разметку стилями. Тому, у
  // кого нет права менять актуальность, переключатель не отдаётся
  // вообще, чтобы кнопок не было и в исходнике страницы.
  if (!can('recipe.status')) return '';
  var cur = recipeStatus(r);
  var buttons = RECIPE_STATUSES.map(function(s) {
    return '<button type="button" class="status-opt' + (cur === s.id ? ' is-current' : '') + '"' +
      ' title="' + escAttr(s.label) + '"' +
      ' onclick="event.stopPropagation(); setRecipeStatus(\'' + escAttr(r.id) + '\', \'' + escAttr(s.id) + '\')">' +
      esc(s.icon) + '<span class="status-opt-label">' + esc(s.short) + '</span></button>';
  }).join('');
  return '<div class="card-status-switch admin-only" onclick="event.stopPropagation()">' + buttons + '</div>';
}

/* Смена статуса. Отдельно от saveRecipe: это правка одного поля, ради
   которой не нужно открывать форму и пересобирать рецепт целиком. */
function setRecipeStatus(id, status) {
  if (!can('recipe.status')) { denyToast('recipe.status'); return; }
  var r = null;
  for (var i = 0; i < recipes.length; i++) {
    if (recipes[i].id === id) { r = recipes[i]; break; }
  }
  if (!r) { showToast('⚠️ Рецепт не найден'); return; }
  if (recipeStatus(r) === status) return; // нажали на уже выбранный — ничего не делаем

  r.status = status;
  stampEdit(r, 'изменил актуальность на «' + statusMeta(status).label + '»');
  if (!saveAll()) return;

  var m = statusMeta(status);
  logActivity('изменил актуальность рецепта', sectionLabel(recipeSectionId(r)), r.name + ': ' + m.label);
  showToast(m.icon + ' «' + r.name + '» — ' + m.label +
    (status === 'active' ? '' : '. Сотрудники этот рецепт больше не видят'));
  refreshAllSectionLists();
  if (currentTab === 'detail') openDetail(id); // если открыта карточка — обновляем и её
}

function renderCards(containerEl, countEl, items, emptyText) {
  countEl.textContent = 'Всего: ' + items.length;

  if (!items.length) {
    containerEl.innerHTML = '<div class="empty-state"><div class="empty-icon">🍕</div>\n'
      + '<p>' + emptyText + '</p></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < items.length; i++) {
    var r = items[i];
    // Подпись, эмодзи и цвет берутся из настроек категорий
    // (siteConfig.categories), а не из зашитого словаря — поэтому
    // переименование категории сразу видно на всех карточках.
    var cat = recipeCategoryById(r.type);
    var catIcon = (cat && cat.icon) ? cat.icon : '🍽';
    var catName = cat ? cat.label : 'Без категории';
    var catColor = (cat && cat.color) ? cat.color : '#5a5a60';
    var delay = Math.min(i, 8) * 0.04;
    var st = recipeStatus(r);
    var stMeta = statusMeta(st);
    var videos = getRecipeVideos(r);

    /* Состав отдельной строкой под названием. Раньше ингредиенты нигде в
       списке не показывались, и рецепты с похожими названиями («Пинса
       Курица-Грибы» и «Пинса Курица») различались только открытием
       каждого. Строка обрезается многоточием, чтобы карточки оставались
       одной высоты. */
    var composition = (r.ingredients && r.ingredients.length)
      ? r.ingredients.slice(0, 6).map(function(x) { return String(x).split(/\s+—|\s+-\s/)[0].trim(); }).join(', ')
      : '';

    html += '<div class="recipe-card ctype-' + escAttr(r.type || '') + (st !== 'active' ? ' recipe-card-inactive' : '') +
        '" style="animation-delay:' + delay + 's;--card-accent:' + escAttr(catColor) + '" onclick="openDetail(\'' + r.id + '\')">' +

      // Обложка во всю ширину карточки. Без фото — плашка цвета
      // категории со значком: так список выглядит ровно даже когда
      // снимки есть не у всех рецептов.
      '<div class="card-cover' + (r.photo ? '' : ' card-cover-empty') + '"' +
        (r.photo ? '' : ' style="background:' + escAttr(catColor) + '26"') + '>' +
        (r.photo
          ? '<img class="card-thumb" src="' + escAttr(resolvePhotoSrc(r.photo)) + '" alt="" loading="lazy">'
          : '<span class="card-cover-icon">' + esc(catIcon) + '</span>') +
        (videos.length
          ? '<button type="button" class="card-video-btn" title="Смотреть видео" onclick="event.stopPropagation(); openDetail(\'' + r.id + '\', true)">' +
              '<svg viewBox="0 0 24 24"><path d="M8 6l10 6-10 6V6z"></path></svg></button>'
          : '') +
      '</div>' +

      '<div class="card-info">\n'
      + '  <div class="card-title-row">' +
          '<h3>' + esc(r.name) + '</h3>' +
          (r.weight ? '<span class="card-weight">' + esc(formatWeight(r.weight)) + '</span>' : '') +
        '</div>\n'
      + (composition ? '  <p class="card-composition">' + esc(composition) + '</p>\n' : '')
      + '  <div class="card-meta">' +
        '<span class="badge badge-status status-' + escAttr(st) + '" title="' + escAttr(stMeta.label) + '">' + esc(stMeta.short) + '</span>' +
        '<span class="badge type-badge" style="background:' + escAttr(catColor) + '">' + esc(catName) + '</span>' +
        (r.style ? '<span class="badge badge-style">' + esc(r.style) + '</span>' : '') +
        (r.calories ? '<span class="badge badge-cal">' + r.calories + ' ккал</span>' : '') +
        '<span class="card-actions">' +
          '<button type="button" class="card-icon-btn" title="Поделиться ссылкой" onclick="event.stopPropagation(); shareRecipeLink(\'' + r.id + '\')">' +
            '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"></line><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line></svg>' +
          '</button>' +
          // Меню карточки: переключатель актуальности убран под него.
          // Три кнопки статуса на каждой из сорока карточек и делали из
          // списка стену кнопок.
          (canSeeAllRecipeStatuses()
            ? '<button type="button" class="card-icon-btn" title="Действия" onclick="event.stopPropagation(); toggleCardMenu(this)">' +
                '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="12" cy="19" r="1.6"></circle></svg>' +
              '</button>'
            : '') +
        '</span>' +
      '</div>\n'
      + recipeStatusSwitchHtml(r)
      + '</div>'
    + '</div>';
  }
  containerEl.innerHTML = html;
}

/* Раскрывает меню карточки (сейчас в нём переключатель актуальности).
   Открытое меню одно на список: два раскрытых блока в сетке смотрелись
   бы как сбой вёрстки. */
function toggleCardMenu(btn) {
  var card = btn.closest('.recipe-card');
  if (!card) return;
  var open = card.classList.contains('menu-open');
  document.querySelectorAll('.recipe-card.menu-open').forEach(function(el) { el.classList.remove('menu-open'); });
  if (!open) card.classList.add('menu-open');
}


function applySearch(items, inputId) {
  var input = $(inputId);
  var q = input ? input.value.trim().toLowerCase() : '';
  if (!q) return items;
  return items.filter(function(r) { return r.name && r.name.toLowerCase().indexOf(q) !== -1; });
}

function toggleSearchClear(inputId) {
  var input = $(inputId);
  var clearBtn = $(inputId + '-clear');
  if (!input || !clearBtn) return;
  clearBtn.style.display = input.value ? 'flex' : 'none';
}

function clearSearchInput(inputId) {
  var input = $(inputId);
  if (!input) return;
  input.value = '';
  toggleSearchClear(inputId);
  input.focus();
  if (inputId === 'purchase-home-search') renderPurchaseHomeList();
  if (inputId.indexOf('search-section-') === 0) renderSectionList(inputId.slice('search-section-'.length));
}

/* ================================================================
   ВКЛАДКА "АДМИН-ПАНЕЛЬ"
   ================================================================ */
/* Длинные пояснения в админ-панели свёрнуты до трёх строк. Нажатие
   раскрывает — инструкцию читают один раз, а карточками пользуются
   каждый день, и текст не должен занимать пол-экрана. */
document.addEventListener('click', function(e) {
  if (!e.target.closest) return;
  var hint = e.target.closest('.admin-panel-hint') || e.target.closest('.ingr-calc-hint');
  if (hint) hint.classList.toggle('expanded');
});

function renderAdminPanel() {
  restoreAdminGroups();
  renderActivityLog();
  syncActivityFromGithub(); // в фоне: у коллег могли появиться новые записи
  renderAdminPermsSummary();
  renderVenuesAdminList();
  renderSectionsAdminList();
  var countEl = $('admin-total-count');
  if (countEl) {
    // Разделяем «здесь» и «во всей сети»: без этого админ одной точки
    // видел бы чужие цифры и считал, что у него больше рецептов.
    var mine = 0;
    sectionsForVenue(currentVenueId()).forEach(function(s) { mine += recipesForSection(s.id).length; });
    countEl.textContent = getVenues().length > 1
      ? (mine + ' шт. в «' + (venueById(currentVenueId()) || {}).label + '» · ' + recipes.length + ' во всей сети')
      : (recipes.length + ' шт.');
  }
  var panelBtn = $('admin-panel-toggle-btn');
  if (panelBtn) panelBtn.textContent = isAdmin() ? '🔓 Выйти' : '🔒 Войти';

  var statusEl = $('gh-sync-status');
  var linkEl = $('gh-sync-link');
  if (!statusEl || !linkEl) return;

  var cfg = getGithubConfig();
  if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) {
    statusEl.textContent = '⚪ Синхронизация ещё не настроена';
    statusEl.style.color = 'var(--text-muted)';
    linkEl.innerHTML = '';
    return;
  }

  var sourceNote = dataSource === 'github'
    ? '📥 Сейчас показаны данные, реально полученные с GitHub только что.'
    : '📥 Сейчас показаны локальные данные этого устройства (получить свежие с GitHub не удалось — см. статус ниже).';

  var raw = null;
  try { raw = JSON.parse(localStorage.getItem(GH_STATUS_KEY)); } catch(e) {}

  if (!raw) {
    statusEl.textContent = '⚪ Настроено, но синхронизации ещё не было';
    statusEl.style.color = 'var(--text-muted)';
  } else {
    var when = new Date(raw.time).toLocaleString('ru-RU');
    if (raw.ok) {
      statusEl.textContent = '🟢 Последняя публикация успешна: ' + when;
      statusEl.style.color = '#8fe3ac';
    } else {
      statusEl.textContent = '🔴 Ошибка публикации (' + when + '): ' + (raw.error || '');
      statusEl.style.color = '#ff9aa8';
    }
  }

  var fileUrl = 'https://github.com/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/blob/' + encodeURIComponent(cfg.branch) + '/' + GH_DATA_PATH;
  linkEl.innerHTML = sourceNote + '<br><a href="' + fileUrl + '" target="_blank" rel="noopener" style="color:var(--accent)">Открыть ' + GH_DATA_PATH + ' на GitHub →</a>';
}

/* ================================================================
   КАЛЬКУЛЯТОР ИНГРЕДИЕНТОВ (пропорциональный пересчёт раскладки)
   ================================================================
   Ингредиенты хранятся в рецептах простой строкой вида
   "Говядина 1600г". Мы разбираем такую строку на название,
   число и единицу измерения. Когда пользователь меняет
   количество ЛЮБОГО ингредиента (и, если применимо, единицу —
   г/кг, мл/л), мы вычисляем коэффициент пересчёта относительно
   исходного рецепта и применяем его ко всем остальным
   ингредиентам этой карточки. Работает одинаково для всех
   рецептов — отдельного калькулятора на каждую карточку не нужно.
*/
var UNIT_FACTORS = {
  'г': 1, 'кг': 1000,
  'мл': 1, 'л': 1000,
  'шт': 1
};
var UNIT_GROUPS = {
  weight: ['г', 'кг'],
  volume: ['мл', 'л'],
  count: ['шт']
};
function normalizeUnit(u) {
  if (!u) return '';
  u = u.trim().toLowerCase().replace(/\.$/, '');
  if (u === 'g') return 'г';
  if (u === 'kg') return 'кг';
  if (u === 'ml') return 'мл';
  if (u === 'l') return 'л';
  if (u === 'pcs' || u === 'шт') return 'шт';
  if (u === 'г' || u === 'кг' || u === 'мл' || u === 'л') return u;
  return u;
}
function unitGroupFor(unit) {
  if (UNIT_GROUPS.weight.indexOf(unit) !== -1) return 'weight';
  if (UNIT_GROUPS.volume.indexOf(unit) !== -1) return 'volume';
  if (UNIT_GROUPS.count.indexOf(unit) !== -1) return 'count';
  return null;
}
function formatQty(num) {
  if (!isFinite(num)) return '';
  var rounded = Math.round(num * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 0.005) return String(Math.round(rounded));
  return String(rounded);
}
function parseIngredientLine(raw) {
  var m = raw.match(/^(.*?)(\d+(?:[.,]\d+)?)\s*(кг|г\.?|мл|л|шт\.?|kg|g|ml|l)?(.*)$/i);
  if (!m) return { raw: raw, matched: false };
  var amount = parseFloat(m[2].replace(',', '.'));
  if (!isFinite(amount)) return { raw: raw, matched: false };
  return {
    raw: raw,
    matched: true,
    name: m[1].trim(),
    amount: amount,
    unit: normalizeUnit(m[3] || ''),
    suffix: (m[4] || '').trim()
  };
}
function renderIngredientsCalc(r) {
  var parsed = (r.ingredients && r.ingredients.map) ? r.ingredients.map(parseIngredientLine) : [];
  window.__ingrCalc = parsed;
  window.__ingrCalcRecipe = r;

  var rowsHtml = parsed.map(function(p, idx) {
    if (!p.matched) {
      return '<div class="ingr-row ingr-row-plain">• ' + esc(p.raw) + '</div>';
    }
    var group = unitGroupFor(p.unit);
    var unitHtml;
    if (group && UNIT_GROUPS[group].length > 1) {
      unitHtml = '<select class="ingr-unit" data-idx="' + idx + '" onchange="ingrCalcRecompute(' + idx + ')">' +
        UNIT_GROUPS[group].map(function(u) {
          return '<option value="' + u + '"' + (u === p.unit ? ' selected' : '') + '>' + u + '</option>';
        }).join('') +
        '</select>';
    } else {
      unitHtml = p.unit ? '<span class="ingr-unit-static">' + esc(p.unit) + '</span>' : '';
    }
    return '<div class="ingr-row">' +
      '<span class="ingr-name">' + esc(p.name) +
        (p.suffix ? ' <span class="ingr-suffix">' + esc(p.suffix) + '</span>' : '') +
      '</span>' +
      '<span class="ingr-controls">' +
        '<input type="number" inputmode="decimal" step="any" class="ingr-input" data-idx="' + idx + '" ' +
          'value="' + formatQty(p.amount) + '" oninput="ingrCalcRecompute(' + idx + ')">' +
        unitHtml +
      '</span>' +
    '</div>';
  }).join('');

  return '<div class="ingr-calc">' +
    '<div class="ingr-calc-hint">🧮 Введите нужное количество любого ингредиента (при необходимости смените г/кг или мл/л) — остальные пересчитаются автоматически.</div>' +
    rowsHtml +
    '<button type="button" class="btn btn-ghost btn-sm ingr-calc-reset" onclick="resetIngrCalc()">↺ Сбросить к исходному рецепту</button>' +
  '</div>';
}
// Названия ингредиентов, которые в разделе "Тесто" считаются
// одной общей жидкостью (лёд тает в воду) — см. ingrCalcRecompute.
function isIceIngredient(name) { return /^л[её]д\s*краш$/i.test((name || '').trim()); }
function isWaterIngredient(name) { return /^вода$/i.test((name || '').trim()); }

function ingrCalcRecompute(anchorIdx) {
  var parsed = window.__ingrCalc;
  if (!parsed) return;
  var input = document.querySelector('.ingr-input[data-idx="' + anchorIdx + '"]');
  if (!input) return;
  var enteredVal = parseFloat((input.value || '').replace(',', '.'));
  if (!isFinite(enteredVal) || enteredVal < 0) return;

  var anchor = parsed[anchorIdx];
  var select = document.querySelector('.ingr-unit[data-idx="' + anchorIdx + '"]');
  var enteredUnit = select ? select.value : anchor.unit;
  var factorEntered = UNIT_FACTORS[enteredUnit] || 1;
  var factorOriginal = UNIT_FACTORS[anchor.unit] || 1;

  // Особый случай — только для "Тесто": лёд краш и вода одного этапа
  // считаются общей жидкостью. Меняем анкор — на столько же грамм,
  // но в обратную сторону, сдвигаем его пару. Остальные ингредиенты
  // калькулятора не трогаем.
  var recipe = window.__ingrCalcRecipe;
  if (recipe && recipe.type === 'dough' && (isIceIngredient(anchor.name) || isWaterIngredient(anchor.name))) {
    var iceIdxs = [], waterIdxs = [];
    parsed.forEach(function(p, idx) {
      if (!p.matched) return;
      if (isIceIngredient(p.name)) iceIdxs.push(idx);
      else if (isWaterIngredient(p.name)) waterIdxs.push(idx);
    });
    var isAnchorIce = isIceIngredient(anchor.name);
    var ownGroup = isAnchorIce ? iceIdxs : waterIdxs;
    var pairGroup = isAnchorIce ? waterIdxs : iceIdxs;
    var posInGroup = ownGroup.indexOf(anchorIdx);
    var partnerIdx = posInGroup !== -1 ? pairGroup[posInGroup] : undefined;

    if (partnerIdx !== undefined) {
      var partner = parsed[partnerIdx];
      var partnerFactor = UNIT_FACTORS[partner.unit] || 1;
      var deltaGrams = (enteredVal * factorEntered) - (anchor.amount * factorOriginal);
      var partnerNewGrams = Math.max(0, (partner.amount * partnerFactor) - deltaGrams);
      var partnerInput = document.querySelector('.ingr-input[data-idx="' + partnerIdx + '"]');
      if (partnerInput) partnerInput.value = formatQty(partnerNewGrams / partnerFactor);
      return; // остальные ингредиенты не пересчитываем
    }
    // нет пары (например, у "Закваски" нет льда) — считаем как обычно ниже
  }

  var ratio = (enteredVal * factorEntered) / (anchor.amount * factorOriginal);
  if (!isFinite(ratio) || ratio <= 0) return;

  parsed.forEach(function(p, idx) {
    if (!p.matched || idx === anchorIdx) return;
    var fieldInput = document.querySelector('.ingr-input[data-idx="' + idx + '"]');
    if (fieldInput) fieldInput.value = formatQty(p.amount * ratio);
  });
}
function resetIngrCalc() {
  var r = window.__ingrCalcRecipe;
  if (!r) return;
  var holder = document.querySelector('.ingr-calc');
  if (holder) holder.outerHTML = renderIngredientsCalc(r);
}

/* ================================================================
   ЗАКУПКА (калькулятор недельной закупки: Пицца бар / Горячий цех)
   ================================================================
   Логика: для каждой позиции вводится "Норма" (сколько должно быть
   на неделю по стандарту) и "Остаток" (что реально взвесили на месте).
   Докупить = Норма − Остаток, округлённое до ближайшего целого числа
   (например 12,1 → 12; 12,6 → 13) — так, как выгоднее по факту,
   без завышения закупки на лишние доли кг/шт.
   Данные хранятся в localStorage, отдельно для каждой из двух
   категорий: "pizza" (Пицца бар) и "hot" (Горячий цех).
   ================================================================ */
var PURCHASE_STORAGE_KEY = 'route20_purchase_v1';
var purchaseCategories = defaultPurchaseCategories();
var purchaseData = { pizza: [], hot: [] };
var currentPurchaseCategory = 'pizza';

/* Общий (для всех цехов/поставщиков и всех сотрудников) список
   нестандартных единиц измерения, когда-либо добавленных вручную через
   "+ своя…" (см. registerCustomUnit/handlePurchaseUnitChange). Хранится
   и синхронизируется вместе с шаблоном закупки (purchase.json →
   customUnits), поэтому единица, введённая один раз на любой позиции,
   сразу становится доступна для выбора на ВСЕХ позициях у всех — а не
   только там, где её ввели. Количество единиц не ограничено; удалить
   ненужные можно через "🗑 Управление единицами…" (см.
   manageCustomUnitsModal) — но только те, что нигде не используются.
   Базовые "кг"/"шт" (PURCHASE_BASE_UNITS) сюда не попадают — они и так
   всегда доступны. */
var purchaseCustomUnits = [];

/* Режим редактирования шаблона закупки — по умолчанию ВЫКЛЮЧЕН, даже для
   администраторов и разработчика: как и с карточками рецептов, сначала
   нужно явно нажать "✏️ Редактировать шаблон", и только тогда поля
   название/ед./норма становятся редактируемыми. Пока режим выключен,
   админ видит шаблон так же, как обычный гость — может вписать только
   свой остаток. Это защищает от случайной правки шаблона на лету. */
var purchaseTemplateEditMode = false;

/* Снимок позиций на момент входа в режим правки. По нему при выходе
   считается, что именно человек изменил: писать в журнал каждое
   нажатие клавиши бессмысленно, а «трогал шаблон» — бесполезно.
   Нужен именно ответ «кто поменял недельную норму муки». */
var purchaseTemplateSnapshot = null;

function makePurchaseSnapshot(cat) {
  var out = {};
  purchaseRowsFor(cat).forEach(function(r) {
    out[r.id] = { name: r.name, unit: r.unit, norm: r.norm };
  });
  return out;
}

/* Сравнивает снимок с текущим состоянием и описывает изменения
   словами. Возвращает массив строк вида «Мука: норма 20 → 25». */
function describePurchaseChanges(before, cat) {
  var lines = [];
  var now = makePurchaseSnapshot(cat);
  Object.keys(now).forEach(function(id) {
    var a = before[id], b = now[id];
    if (!a) { lines.push('добавлена позиция «' + b.name + '»'); return; }
    var parts = [];
    if ((a.name || '') !== (b.name || '')) parts.push('название ' + a.name + ' → ' + b.name);
    if ((a.unit || '') !== (b.unit || '')) parts.push('единица ' + (a.unit || '—') + ' → ' + (b.unit || '—'));
    if (String(a.norm || '') !== String(b.norm || '')) parts.push('недельная норма ' + (a.norm || '—') + ' → ' + (b.norm || '—'));
    if (parts.length) lines.push(b.name + ': ' + parts.join(', '));
  });
  Object.keys(before).forEach(function(id) {
    if (!now[id]) lines.push('удалена позиция «' + before[id].name + '»');
  });
  return lines;
}

async function togglePurchaseTemplateEdit() {
  if (!can('purchase.template')) { denyToast('purchase.template'); return; }
  if (purchaseTemplateEditMode) {
    // Выход из режима редактирования: сначала пытаемся сохранить то, что
    // успели поправить (минуя debounce), и выходим из режима ТОЛЬКО если
    // сохранение реально прошло успешно. Если сохранить не удалось —
    // остаёмся в режиме редактирования (точная причина ошибки уже
    // показана тостом внутри savePurchaseTemplateNow), чтобы правки не
    // выглядели "потерянными" из-за проблем с сетью/GitHub.
    var toggleBtn = $('purchase-edit-toggle-btn');
    if (toggleBtn) toggleBtn.disabled = true;
    var ok = await savePurchaseTemplateNow(true);
    if (toggleBtn) toggleBtn.disabled = false;
    if (!ok) return;
    purchaseTemplateEditMode = false;

    // Записываем в журнал именно то, что изменилось. Если не изменилось
    // ничего — молчим: «зашёл и вышел» истории не нужен.
    if (purchaseTemplateSnapshot) {
      var c = purchaseCategoryById(currentPurchaseCategory);
      var changes = describePurchaseChanges(purchaseTemplateSnapshot, currentPurchaseCategory);
      if (changes.length) {
        logActivity(
          'изменил шаблон закупки',
          'Закупка · ' + venueLabel(currentVenueId()) + ' · ' + (c ? c.label : ''),
          changes.slice(0, 8).join('; ') + (changes.length > 8 ? ' и ещё ' + (changes.length - 8) : '')
        );
      }
      purchaseTemplateSnapshot = null;
    }
  } else {
    purchaseTemplateEditMode = true;
    purchaseTemplateSnapshot = makePurchaseSnapshot(currentPurchaseCategory);
  }
  renderPurchaseList();
  updatePurchaseTemplateControls();
}

/* Подписи у кнопок панели состоят из значка и текста в отдельных
   span'ах (на узком экране текст прячется), поэтому меняем их через
   эту помощницу, а не через textContent — иначе разметка кнопки
   затиралась бы простым текстом. */
function setToolBtn(btn, icon, label, done) {
  if (!btn) return;
  var iconEl = btn.querySelector('.tool-btn-icon');
  var labelEl = btn.querySelector('.tool-btn-label');
  if (iconEl) iconEl.textContent = icon;
  if (labelEl) labelEl.textContent = label;
  // Галочка «уже заполнено» — отдельным значком, чтобы она была видна и
  // тогда, когда подпись скрыта.
  btn.classList.toggle('is-done', !!done);
}

function updatePurchaseTemplateControls() {
  var toggleBtn = $('purchase-edit-toggle-btn');
  var importBtn = $('purchase-import-btn');
  var renameBtn = $('purchase-rename-btn');
  var linkBtn = $('purchase-link-workshop-btn');
  var linkContactBtn = $('purchase-link-contact-btn');
  if (toggleBtn) {
    setToolBtn(toggleBtn,
      purchaseTemplateEditMode ? '✅' : '✏️',
      purchaseTemplateEditMode ? 'Готово' : 'Редактировать шаблон');
    toggleBtn.title = purchaseTemplateEditMode
      ? 'Сохранить и выйти из режима редактирования'
      : 'Редактировать шаблон';
  }
  // Загрузка прайса привязана к тому поставщику/цеху, который сейчас
  // открыт для редактирования, — поэтому кнопка доступна только внутри
  // режима редактирования шаблона, а не постоянно: иначе было бы не
  // очевидно, в какую именно категорию упадут позиции из файла.
  if (importBtn) importBtn.style.display = purchaseTemplateEditMode ? '' : 'none';
  var canManage = isAdmin() && purchaseTemplateEditMode;
  var c = purchaseCategoryById(currentPurchaseCategory);
  if (renameBtn) renameBtn.style.display = canManage ? '' : 'none';
  // Удаление цеха/поставщика теперь делается иконкой 🗑️ прямо на главной
  // странице закупки (см. renderPurchaseHomeList) — здесь, внутри
  // редактирования конкретной карточки, эта кнопка больше не нужна.
  if (linkBtn) linkBtn.style.display = (canManage && c && !c.builtin) ? '' : 'none';
  if (linkContactBtn) {
    linkContactBtn.style.display = canManage ? '' : 'none';
    setToolBtn(linkContactBtn, '📨', 'Ссылка', !!(c && c.link));
  }
  var contactsBtn = $('purchase-contacts-btn');
  if (contactsBtn) {
    contactsBtn.style.display = canManage ? '' : 'none';
    setToolBtn(contactsBtn, '📇', 'Контакты', purchaseContacts(c).length > 0);
  }
  var botBtn = $('purchase-bot-btn');
  if (botBtn) {
    botBtn.style.display = canManage ? '' : 'none';
    setToolBtn(botBtn, '🤖', 'Бот', !!getTelegramBotToken());
  }
  var chatIdBtn = $('purchase-chatid-btn');
  if (chatIdBtn) {
    // Кнопка доступна всегда: идентификатор полезен и группе с коротким
    // именем — число не меняется, даже если имя переименуют или группу
    // снова сделают приватной. Прежнее условие пыталось угадать «нужен
    // или нет» по виду ссылки и у половины поставщиков кнопку прятало.
    chatIdBtn.style.display = canManage ? '' : 'none';
    setToolBtn(chatIdBtn, '🆔', 'ID чата', !!(c && c.chatId));
  }
}

/* Ручное сохранение шаблона в GitHub сразу, минуя обычную задержку
   (debounce) автосохранения — на случай медленного интернета или чтобы
   быть уверенным, что правки точно ушли, прежде чем закрыть вкладку.
   silent=true — не показывать лишний тост об успехе (используется при
   автоматическом сохранении на выходе из режима редактирования).
   Возвращает true/false — вызывающий код (например, togglePurchaseTemplateEdit)
   использует это, чтобы решить, можно ли считать сохранение завершённым. */
async function savePurchaseTemplateNow(silent) {
  if (!can('purchase.template')) { denyToast('purchase.template'); return false; }
  clearTimeout(purchaseSyncDebounceTimer);
  if (!silent) showToast('⏳ Сохраняю шаблон...');
  var ok = await syncPurchaseToGithub();
  if (ok && !silent) showToast('✅ Шаблон закупки сохранён в GitHub');
  // при ok===false внутри syncPurchaseToGithub уже показан тост с точной причиной — не перезаписываем его
  return ok;
}

function loadPurchaseData() {
  try {
    var stored = localStorage.getItem(PURCHASE_STORAGE_KEY);
    var parsed = stored ? JSON.parse(stored) : null;
    if (parsed && Array.isArray(parsed.categories) && parsed.data && typeof parsed.data === 'object') {
      purchaseCategories = parsed.categories;
      purchaseData = parsed.data;
    } else if (parsed && (Array.isArray(parsed.pizza) || Array.isArray(parsed.hot))) {
      // старый формат хранения (до появления поставщиков)
      purchaseCategories = defaultPurchaseCategories();
      purchaseData = { pizza: Array.isArray(parsed.pizza) ? parsed.pizza : [], hot: Array.isArray(parsed.hot) ? parsed.hot : [] };
    } else {
      purchaseCategories = defaultPurchaseCategories();
      purchaseData = {};
    }
    purchaseCustomUnits = (parsed && Array.isArray(parsed.customUnits)) ? parsed.customUnits : [];
  } catch (e) {
    purchaseCategories = defaultPurchaseCategories();
    purchaseData = {};
    purchaseCustomUnits = [];
  }
  if (!Array.isArray(purchaseCategories) || !purchaseCategories.length) purchaseCategories = defaultPurchaseCategories();
  if (!purchaseData || typeof purchaseData !== 'object') purchaseData = {};
  purchaseCategories.forEach(function(c) { if (!Array.isArray(purchaseData[c.id])) purchaseData[c.id] = []; });
  ensurePurchaseCategoryOfVenue();
}

/* Открытый цех должен принадлежать открытому заведению — иначе после
   загрузки или переключения точки на вкладке «Закупка» показался бы
   чужой цех. */
function ensurePurchaseCategoryOfVenue() {
  var mine = venuePurchaseCategories();
  if (mine.some(function(c) { return c.id === currentPurchaseCategory; })) return;
  currentPurchaseCategory = mine.length ? mine[0].id : '';
}

function savePurchaseData() {
  try { localStorage.setItem(PURCHASE_STORAGE_KEY, JSON.stringify({ categories: purchaseCategories, data: purchaseData, customUnits: purchaseCustomUnits })); } catch (e) {}
}

function purchaseRowsFor(cat) {
  if (!Array.isArray(purchaseData[cat])) purchaseData[cat] = [];
  // На старых сохранённых данных (до появления колонки "Дозаказ") поля
  // reorder ещё нет — подставляем пустую строку, чтобы поле было и
  // сразу редактировалось, не ломая старые записи. Единица дозаказа
  // (reorderUnit) — отдельная от основной единицы позиции (row.unit),
  // по умолчанию "кг", тоже подставляется на старых записях.
  purchaseData[cat].forEach(function(r) {
    if (r.reorder === undefined) r.reorder = '';
    if (!r.reorderUnit) r.reorderUnit = 'кг';
  });
  return purchaseData[cat];
}

function purchaseCategoryById(cat) {
  return purchaseCategories.find(function(c) { return c.id === cat; }) || null;
}

function purchaseCategoryLabel(cat) {
  var c = purchaseCategoryById(cat);
  return c ? c.label : cat;
}

function purchaseCategoryIcon(cat) {
  var c = purchaseCategoryById(cat);
  return (c && c.icon) || '📦';
}

/* Список встроенных цехов (Пицца бар / Горячий цех, и любые другие,
   которые появятся в будущем) — варианты, к которым можно привязать
   поставщика. "Без привязки" — тоже допустимый вариант: такой
   поставщик просто не попадает ни в один общий список цеха. */
function purchaseWorkshopOptions() {
  // Только цеха ОТКРЫТОГО заведения: привязать поставщика к цеху другой
  // точки нельзя — у них разные закупки.
  var opts = venuePurchaseCategories().filter(function(c) { return c.builtin; }).map(function(c) {
    return { value: c.id, label: (c.icon || '📦') + ' ' + c.label };
  });
  opts.push({ value: '', label: '— без привязки к цеху —' });
  return opts;
}

/* Категории, чьи позиции должны попадать в "Общий список"/"Общий отчёт"
   конкретного цеха: сам цех плюс все поставщики, привязанные именно к
   нему (c.workshop === workshopCat). Поставщики без привязки или
   привязанные к другому цеху сюда не попадают. */
function purchaseCategoriesForWorkshop(workshopCat) {
  var list = [];
  var self = purchaseCategoryById(workshopCat);
  if (self) list.push(self);
  var venue = self ? purchaseCategoryVenueId(self) : currentVenueId();
  purchaseCategories.forEach(function(c) {
    if (!c.builtin && c.workshop === workshopCat && purchaseCategoryVenueId(c) === venue) list.push(c);
  });
  return list;
}

/* ================================================================
   ГЛАВНАЯ СТРАНИЦА ЗАКУПКИ (список цехов и поставщиков) И
   ДЕТАЛЬНЫЙ ЭКРАН (позиции одного конкретного цеха/поставщика)
   ================================================================
   Раньше все цеха/поставщики были в одну строку чипов над общим
   списком позиций — при большом числе поставщиков это быстро
   становилось нечитаемым. Теперь вкладка "Закупка" — это сначала
   главная страница со списком карточек (цеха отдельно, поставщики
   отдельно), а сами позиции открываются на отдельном экране по клику
   на карточку. purchaseHomeView управляет тем, какой из двух экранов
   сейчас показан; currentPurchaseCategory — какой именно цех/поставщик
   открыт на детальном экране (используется во всех остальных функциях
   закупки без изменений). */
var purchaseHomeView = true;

function updatePurchaseViewVisibility() {
  var home = $('purchase-home-view');
  var detail = $('purchase-detail-view');
  if (home) home.style.display = purchaseHomeView ? '' : 'none';
  if (detail) detail.style.display = purchaseHomeView ? 'none' : '';
}

/* Единая точка входа для отрисовки всей вкладки "Закупка" — главную
   страницу обновляем всегда (она дешёвая), детальный экран — только
   если он сейчас показан. Используется при заходе на вкладку и после
   фоновой синхронизации с GitHub. */
function renderPurchaseTab() {
  renderPurchaseHomeList();
  if (!purchaseHomeView) renderPurchaseList();
  updatePurchaseViewVisibility();
}

function showPurchaseHome() {
  purchaseHomeView = true;
  renderPurchaseHomeList();
  updatePurchaseViewVisibility();
  if (window.refreshFloatingBackButton) window.refreshFloatingBackButton();
}

function showPurchaseDetail(cat) {
  currentPurchaseCategory = cat;
  purchaseHomeView = false;
  var c = purchaseCategoryById(cat);
  var titleEl = $('purchase-detail-title');
  if (titleEl) titleEl.textContent = (c && c.icon || '📦') + ' Закупка на неделю + дозаказ — ' + (c ? esc(c.label) : '');
  updatePurchaseTemplateControls();
  renderPurchaseDetailContacts();
  // Сбрасываем поиск позиций при переходе в другую категорию — иначе
  // список открывался бы уже отфильтрованным по запросу из предыдущего
  // цеха/поставщика, что выглядело бы как баг ("почему тут пусто").
  var searchInput = $('purchase-search-positions');
  if (searchInput) searchInput.value = '';
  toggleSearchClear('purchase-search-positions');
  renderPurchaseList();
  updatePurchaseViewVisibility();
  window.scrollTo(0, 0);
  if (window.refreshFloatingBackButton) window.refreshFloatingBackButton();
}

/* Открыть карточку сразу в режиме редактирования (клик по иконке ✏️ на
   главной странице) — то же самое, что открыть карточку и затем нажать
   "✏️ Редактировать шаблон" на детальном экране, просто одним кликом. */
function enterPurchaseEditFor(cat) {
  if (!can('purchase.template')) { denyToast('purchase.template'); return; }
  showPurchaseDetail(cat);
  if (!purchaseTemplateEditMode) {
    purchaseTemplateEditMode = true;
    renderPurchaseList();
    updatePurchaseTemplateControls();
  }
}

function renderPurchaseHomeList() {
  var holder = $('purchase-home-list');
  if (!holder) return;

  function cardHtml(c) {
    var workshopMark = '';
    if (!c.builtin && c.workshop) {
      var w = purchaseCategoryById(c.workshop);
      if (w) workshopMark = '<span class="purchase-home-card-meta">' + esc(w.icon || '📦') + ' ' + esc(w.label) + '</span>';
    }
    // Служебные пометки собираем в одну строку под названием: цех,
    // готовность ссылки и кто правил. Раньше каждая занимала
    // собственную строку, и на пятнадцати поставщиках список
    // растягивался на три экрана.
    var linkMark = c.link ? '<span class="purchase-home-card-link-badge">🔗 отправка настроена</span>' : '';
    var contactsMark = purchaseContactsHtml(c); // пусто, если ничего не заполнено
    var stampMark = formatEditStamp(c) ? '<span class="edit-stamp-inline">✏️ ' + esc(formatEditStamp(c)) + '</span>' : '';
    var subParts = [];
    if (workshopMark) subParts.push(workshopMark);
    if (linkMark) subParts.push(linkMark);
    if (stampMark) subParts.push(stampMark);
    var subLine = subParts.length ? '<div class="purchase-home-card-sub">' + subParts.join(' · ') + '</div>' : '';
    return '<div class="purchase-home-card">' +
      '<div class="purchase-home-card-main" onclick="showPurchaseDetail(\'' + c.id + '\')">' +
        '<span class="purchase-home-card-icon">' + esc(c.icon || '📦') + '</span>' +
        '<div class="purchase-home-card-text"><strong>' + esc(c.label) + '</strong>' + subLine + contactsMark + '</div>' +
      '</div>' +
      '<div class="purchase-home-card-actions developer-only">' +
        '<button type="button" class="purchase-home-icon-btn" title="Редактировать" onclick="event.stopPropagation(); enterPurchaseEditFor(\'' + c.id + '\')">✏️</button>' +
        '<button type="button" class="purchase-home-icon-btn purchase-home-icon-btn-danger" title="Удалить" onclick="event.stopPropagation(); removePurchaseCategory(\'' + c.id + '\')">🗑️</button>' +
      '</div>' +
    '</div>';
  }

  // Поиск по названию ИНГРЕДИЕНТА. Раньше запрос только отфильтровывал
  // карточки заведений/поставщиков, оставляя видимой карточку целиком —
  // чтобы внести остаток, приходилось ещё и открывать её, найдя внутри
  // уже нужную позицию (среди чужих). Теперь, пока в поиске что-то
  // введено, главная страница вместо карточек показывает сразу САМИ
  // найденные позиции (у какого бы заведения/поставщика они ни были) —
  // с полями "Остаток"/"Дозаказ" прямо тут, как в общем списке цеха (см.
  // renderPurchaseCombinedList). Внесли остаток → очистили поиск →
  // список карточек вернулся как был → можно искать следующий ингредиент.
  var homeSearchInput = $('purchase-home-search');
  var homeSearchQuery = homeSearchInput ? homeSearchInput.value.trim().toLowerCase() : '';

  if (homeSearchQuery) {
    renderPurchaseHomeSearchResults(holder, homeSearchQuery, homeSearchInput.value.trim());
    return;
  }

  // Закупка показывает только цеха и поставщиков открытого заведения.
  var venueCats = venuePurchaseCategories();
  var workshops = venueCats.filter(function(c) { return c.builtin; });
  var suppliers = venueCats.filter(function(c) { return !c.builtin; });

  // Кнопка "Отправить всё" видна только пока есть что реально заказывать —
  // категория должна иметь ссылку для отправки, содержать хотя бы одну
  // РЕАЛЬНО ЗАПОЛНЕННУЮ пользователем позицию (purchaseCategoryHasTouchedData
  // — остаток или дозаказ не пустые) И хотя бы одну позицию, требующую
  // покупки/дозаказа (см. buildPurchaseReportLines — пустой "Остаток" там
  // трактуется как "ещё не взвесили" и в отчёт не попадает, попадает
  // только реально вписанный 0 или число). Первое условие всё равно нужно
  // отдельно: без него кнопка была бы видна даже сразу после "🧹 Сбросить
  // остатки", когда все поля ещё пустые, просто из-за того, что где-то
  // задана норма. После
  // "✅ Завершить закупку" (finishSendAllPurchase) все обработанные позиции
  // "закрываются", и, если больше нигде ничего не нужно, кнопка сама
  // пропадает — без этого она осталась бы висеть просто из-за наличия
  // ссылки у поставщика, даже когда заказывать уже нечего.
  var sendableCount = venuePurchaseCategories().filter(function(c) {
    return (c.link || '').trim() && purchaseCategoryHasTouchedData(c.id) && buildPurchaseReportLines(c.id).length > 0;
  }).length;
  var html = '';

  // Если рассылка была прервана (например, случайно закрыли вкладку,
  // переключившись в мессенджер посреди отправки) — вместо обычной
  // кнопки показываем баннер с прогрессом и предлагаем продолжить.
  var sendProgress = loadSendAllPurchaseProgress();
  if (sendProgress && sendProgress.index < sendProgress.ids.length) {
    html += '<div class="purchase-send-progress-banner">' +
      '<div class="purchase-send-progress-banner-title">📤 Рассылка не завершена</div>' +
      '<div class="purchase-send-progress-banner-sub">Уже отправлено ' + sendProgress.index + ' из ' + sendProgress.ids.length + '</div>' +
      '<div class="purchase-send-progress-banner-actions">' +
        '<button type="button" class="btn btn-primary btn-sm" onclick="resumeSendAllPurchase()">▶️ Продолжить</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="discardSendAllPurchaseProgress()">Начать заново</button>' +
      '</div>' +
    '</div>';
  } else if (sendableCount) {
    html += '<button type="button" class="btn btn-primary btn-sm" onclick="startSendAllPurchase()" style="width:100%;margin-bottom:18px">📤 Отправить всё поставщикам (' + sendableCount + ')</button>';
  }

  html += '<div class="purchase-home-group-title">🏭 Цеха</div>';
  html += workshops.length ? workshops.map(cardHtml).join('') : '<p class="purchase-home-empty">Пока нет ни одного цеха.</p>';
  html += '<button type="button" class="btn btn-ghost btn-sm developer-only" onclick="addPurchaseWorkshop()" style="width:100%;margin:6px 0 20px">🏭 Добавить цех</button>';

  html += '<div class="purchase-home-group-title">🚚 Поставщики</div>';
  html += suppliers.length ? suppliers.map(cardHtml).join('') : '<p class="purchase-home-empty">Пока нет ни одного поставщика.</p>';
  html += '<button type="button" class="btn btn-ghost btn-sm developer-only" onclick="addPurchaseSupplier()" style="width:100%;margin:6px 0 6px">➕ Добавить поставщика</button>';

  holder.innerHTML = html;
}

/* Режим поиска на главной странице "Закупка": пока в поле что-то введено,
   вместо карточек заведений/поставщиков показываем сразу найденные
   позиции (ингредиенты) — у какого бы заведения/поставщика они ни
   числились — с полями "Остаток"/"Дозаказ" прямо здесь, точно как в
   общем списке цеха (см. renderPurchaseCombinedList). Так пользователь
   может: ввести название ингредиента → сразу увидеть его и внести
   остаток/дозаказ → очистить поиск → искать следующий, не открывая
   карточки поставщиков вручную. Один и тот же id позиции обновляется
   через updatePurchaseField/recomputePurchaseRow — они не привязаны к
   тому, где именно строка отрисована, поэтому значение корректно
   сохранится и отразится, если эта же позиция где-то ещё видна на
   экране (например, в открытой карточке или в общем списке цеха). */
function renderPurchaseHomeSearchResults(holder, query, rawQuery) {
  var matches = [];
  venuePurchaseCategories().forEach(function(c) {
    purchaseRowsFor(c.id).forEach(function(row) {
      if ((row.name || '').trim() && purchaseNameMatchesSearch(row.name, query)) {
        matches.push({ cat: c, row: row });
      }
    });
  });

  if (!matches.length) {
    holder.innerHTML = '<p class="purchase-home-empty">Ничего не найдено по запросу «' + esc(rawQuery) + '».</p>';
    return;
  }

  holder.innerHTML = matches.map(function(entry) {
    var c = entry.cat;
    var row = entry.row;
    var res = purchaseResultDisplay(row);
    var reorderUnit = row.reorderUnit || 'кг';
    var hasValue = (row.residual !== '' && row.residual != null) || (row.reorder !== '' && row.reorder != null);
    return '<div class="purchase-row" data-id="' + row.id + '">' +
      '<div class="purchase-row-readonly-name">' + esc(row.name) +
        '<span class="purchase-row-meta">' + esc(c.icon || '📦') + ' ' + esc(c.label) +
          (row.norm === '' || row.norm == null ? '' : ' · норма: ' + esc(String(row.norm)) + ' ' + esc(row.unit)) +
        '</span>' +
      '</div>' +
      '<div class="purchase-row-fields purchase-row-fields-combined">' +
        '<label class="purchase-field"><span>Остаток</span>' +
          '<input type="number" inputmode="decimal" step="any" min="0" class="purchase-residual" id="purchase-home-residual-' + row.id + '" placeholder="2.3" value="' + escAttr(row.residual) + '" ' +
            'oninput="autosizePurchaseInput(this); updatePurchaseField(\'' + c.id + '\',\'' + row.id + '\',\'residual\',this.value); recomputePurchaseRow(\'' + row.id + '\'); togglePurchaseHomeConfirmBtn(\'' + row.id + '\')">' +
        '</label>' +
        '<div class="purchase-field"><span>Докупить</span>' +
          '<div class="purchase-result ' + res.cls + '" data-result-for="' + row.id + '">' + res.text + '</div>' +
        '</div>' +
        '<label class="purchase-field purchase-field-reorder"><span>🔁 Дозаказ</span>' +
          '<div class="purchase-reorder-group">' +
            '<input type="number" inputmode="decimal" step="any" min="0" class="purchase-reorder" id="purchase-home-reorder-' + row.id + '" placeholder="1" value="' + escAttr(row.reorder) + '" ' +
              'oninput="autosizePurchaseInput(this); updatePurchaseField(\'' + c.id + '\',\'' + row.id + '\',\'reorder\',this.value); togglePurchaseHomeConfirmBtn(\'' + row.id + '\')">' +
            '<select class="purchase-reorder-unit" onchange="handlePurchaseReorderUnitChange(this,\'' + c.id + '\',\'' + row.id + '\')">' +
              purchaseUnitOptionsHtml(reorderUnit) +
            '</select>' +
          '</div>' +
        '</label>' +
      '</div>' +
      '<button type="button" class="btn btn-primary btn-sm purchase-home-confirm-btn" id="purchase-home-confirm-' + row.id + '" ' +
        'style="display:' + (hasValue ? 'block' : 'none') + '" onclick="confirmPurchaseHomeSearchEntry(\'' + row.id + '\')">✅ ОК — сохранить и найти следующее</button>' +
    '</div>';
  }).join('');

  autosizeAllPurchaseInputs(holder);
}

// Показывает/скрывает кнопку "✅ ОК" под конкретной найденной позицией
// в поиске на главной "Закупка" (см. renderPurchaseHomeSearchResults) —
// кнопка появляется, как только хотя бы в одном из полей ("Остаток"
// или "🔁 Дозаказ") этой позиции есть значение, и прячется обратно,
// если оба поля снова очистили.
function togglePurchaseHomeConfirmBtn(rowId) {
  var btn = $('purchase-home-confirm-' + rowId);
  if (!btn) return;
  var residualEl = $('purchase-home-residual-' + rowId);
  var reorderEl = $('purchase-home-reorder-' + rowId);
  var hasValue = (residualEl && residualEl.value !== '') || (reorderEl && reorderEl.value !== '');
  btn.style.display = hasValue ? 'block' : 'none';
}

// Нажатие "✅ ОК" в результатах поиска на главной "Закупка": значения
// уже сохранены по мере ввода (см. oninput на полях выше), поэтому здесь
// достаточно просто сбросить строку поиска — это возвращает главный
// экран к обычному списку заведений/поставщиков и сразу освобождает
// поле для поиска следующего ингредиента, ничего не открывая вручную.
function confirmPurchaseHomeSearchEntry(rowId) {
  showToast('✅ Сохранено');
  clearSearchInput('purchase-home-search');
}

/* "Общий список — все поставщики" и "Общий отчёт" по смыслу относятся
   только к встроенным цехам (Пицца бар / Горячий цех) — там несколько
   поставщиков вносят вклад в один и тот же цех, поэтому удобно свести
   их позиции в одну сплошную ленту для обхода. У отдельного поставщика
   свой список и так один, без разбивки — блок для него скрывается.
   Проверяем именно флаг c.builtin, а не конкретный id, — поэтому если
   в будущем добавится ещё один встроенный цех, логика продолжит
   работать без правок кода. */
function updatePurchaseCombinedSectionVisibility() {
  var section = $('purchase-combined-section');
  if (!section) return;
  var c = purchaseCategoryById(currentPurchaseCategory);
  var isBuiltin = !!(c && c.builtin);
  section.style.display = isBuiltin ? '' : 'none';
  if (isBuiltin) {
    var titleEl = $('purchase-combined-title');
    if (titleEl) titleEl.textContent = '📋 Общий список — ' + (c.icon || '📦') + ' ' + c.label + ' и его поставщики';
    var reportHintEl = $('purchase-combined-report-hint');
    if (reportHintEl) reportHintEl.textContent = 'Общий отчёт по «' + c.label + '» и привязанным к нему поставщикам — с уже указанным остатком по каждому:';
  }
}

/* ===== Цеха =====
   Помимо двух изначальных цехов (Пицца бар / Горячий цех) администратор
   может добавить сколько угодно своих — например "Кондитерский цех"
   или "Цех заготовок". Новый цех работает точно так же, как и
   изначальные — у него свой список позиций с нормой на неделю, свой
   общий список/отчёт (цех + все привязанные к нему поставщики), к нему
   можно привязывать поставщиков через "🔗 Привязать к цеху", его можно
   переименовать и удалить (см. removePurchaseCategory) точно так же,
   как и Пицца бар/Горячий цех — никакой цех ничем не защищён. */
function addPurchaseWorkshop() {
  if (!can('purchase.structure')) { denyToast('purchase.structure'); return; }
  customPrompt('Название нового цеха, например: Горячий цех', '', 'Новый цех').then(function(val) {
    val = (val || '').trim();
    if (!val) return;
    var id = 'ws' + Date.now() + Math.random().toString(36).slice(2, 7);
    purchaseCategories.push(stampEdit({ id: id, label: val, icon: '🏭', builtin: true, venue: currentVenueId() }));
    logActivity('добавил цех в закупку', 'Закупка · ' + venueLabel(currentVenueId()), val);
    purchaseData[id] = [];
    purchaseTemplateEditMode = true; // сразу входим в режим редактирования — дальше сразу добавляют позиции
    savePurchaseData();
    renderPurchaseHomeList();
    showPurchaseDetail(id);
    schedulePurchaseSync();
    showToast('✅ Заведение «' + val + '» добавлено — теперь добавьте позиции или привяжите к нему поставщиков');
  });
}

/* ===== Поставщики =====
   Поставщик — это, по сути, ещё одна категория закупки (наравне со
   встроенными "Пицца бар"/"Горячий цех"), только её может добавить,
   переименовать и удалить сам администратор прямо на месте. Внутри
   работает та же самая механика: позиции, норма на неделю, остаток,
   расчёт "сколько докупить", копирование/выгрузка результата — просто
   в заголовке результата вместо "Пицца бар" будет название поставщика. */
function addPurchaseSupplier() {
  if (!can('purchase.structure')) { denyToast('purchase.structure'); return; }
  customPrompt('Название поставщика, например: ООО «Метро» или ФЛП Иванов', '', 'Новый поставщик').then(function(val) {
    val = (val || '').trim();
    if (!val) return;
    customSelect('К какому цеху относится поставщик «' + val + '»? Его позиции появятся в общем списке и отчёте этого цеха.', purchaseWorkshopOptions(), '', 'Привязать к цеху').then(function(workshop) {
      if (workshop === null) workshop = ''; // отменили выбор цеха — сам поставщик всё равно добавляем, просто без привязки
      var id = 'sup' + Date.now() + Math.random().toString(36).slice(2, 7);
      purchaseCategories.push(stampEdit({ id: id, label: val, icon: '🚚', builtin: false, workshop: workshop, venue: currentVenueId() }));
      logActivity('добавил поставщика', 'Закупка · ' + venueLabel(currentVenueId()), val);
      purchaseData[id] = [];
      purchaseTemplateEditMode = true; // сразу входим в режим редактирования — дальше сразу добавляют позиции
      savePurchaseData();
      renderPurchaseHomeList();
      showPurchaseDetail(id);
      schedulePurchaseSync();
      showToast('✅ Поставщик «' + val + '» добавлен — теперь добавьте позиции для закупки');
    });
  });
}

function renamePurchaseCategory(cat) {
  cat = cat || currentPurchaseCategory;
  if (!can('purchase.structure')) { denyToast('purchase.structure'); return; }
  var c = purchaseCategoryById(cat);
  if (!c) return;
  customPrompt('Новое название:', c.label, 'Переименовать').then(function(val) {
    if (val === null) return;
    val = (val || '').trim();
    if (!val) { showToast('⚠️ Название не может быть пустым'); return; }
    c.label = val;
    stampEdit(c, 'переименовал');
    savePurchaseData();
    renderPurchaseHomeList();
    var titleEl = $('purchase-detail-title');
    if (titleEl && currentPurchaseCategory === cat) titleEl.textContent = (c.icon || '📦') + ' Закупка на неделю + дозаказ — ' + val;
    renderPurchaseList();
    schedulePurchaseSync();
    showToast('✏️ Название обновлено');
  });
}

/* ================================================================
   КОНТАКТЫ ПОСТАВЩИКА (телефон, почта, сайт)
   ================================================================
   Хранятся в самой категории закупки — c.phone / c.email / c.site, —
   поэтому уезжают на GitHub вместе с шаблоном и видны всем, а не
   только тому, кто их вписал.

   Незаполненное поле не показывается вообще: пустая строка «Почта: —»
   только занимает место на телефоне и создаёт ощущение, что данные
   потеряли. Поэтому блок контактов рисуется, лишь когда заполнено хотя
   бы одно поле, и содержит ровно то, что заполнено.
   ================================================================ */
function purchaseContacts(c) {
  if (!c) return [];
  var out = [];
  var phone = (c.phone || '').trim();
  var email = (c.email || '').trim();
  var site = (c.site || '').trim();
  // href для телефона чистим от пробелов и скобок — иначе набор с
  // телефона не сработает; на экране показываем как записали.
  if (phone) out.push({ kind: 'phone', icon: '📞', text: phone, href: 'tel:' + phone.replace(/[^\d+]/g, '') });
  if (email) out.push({ kind: 'email', icon: '✉️', text: email, href: 'mailto:' + email });
  if (site) out.push({ kind: 'site', icon: '🌐', text: site, href: /^[a-z][a-z0-9+.-]*:/i.test(site) ? site : 'https://' + site });
  return out;
}

function purchaseContactsHtml(c, extraClass) {
  var list = purchaseContacts(c);
  if (!list.length) return ''; // ничего не заполнено — блока нет совсем
  // Нажатие не уводит сразу, а спрашивает, что сделать: позвонить или
  // скопировать. Номер нужен по-разному — набрать с этого телефона или
  // передать кому-то в переписке, и угадывать за человека не стоит.
  return '<div class="purchase-contacts' + (extraClass ? ' ' + extraClass : '') + '">' +
    list.map(function(x) {
      return '<button type="button" class="purchase-contact"' +
        ' onclick="event.stopPropagation(); openContactActions(\'' + escAttr(x.kind) + '\', \'' + escAttr(x.text) + '\')">' +
        '<span class="purchase-contact-icon">' + x.icon + '</span>' + esc(x.text) + '</button>';
    }).join('') +
  '</div>';
}

/* Что можно сделать с контактом. Основное действие — ссылка <a>, а не
   кнопка: переход по tel:/mailto:/https должен происходить прямо по
   нажатию, иначе браузер его блокирует (та же причина, что у кнопок
   «Запросить ключ»). */
async function openContactActions(kind, value) {
  var meta = {
    phone: { title: '📞 Телефон', action: 'Позвонить', href: 'tel:' + String(value).replace(/[^\d+]/g, ''), copied: '📋 Номер скопирован' },
    email: { title: '✉️ Почта', action: 'Написать', href: 'mailto:' + value, copied: '📋 Почта скопирована' },
    site: { title: '🌐 Сайт', action: 'Открыть', href: (/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : 'https://' + value), copied: '📋 Адрес скопирован' }
  }[kind];
  if (!meta) return;

  await showModal({
    title: meta.title,
    message: String(value),
    withInput: false,
    hideCancel: true,
    okText: 'Закрыть',
    footerHtml: '<div class="tool-bar" style="justify-content:center">' +
      '<a class="tool-btn tool-btn-primary" href="' + escAttr(meta.href) + '"' +
        (kind === 'site' ? ' target="_blank" rel="noopener"' : '') + '>' +
        '<span class="tool-btn-icon">' + (kind === 'phone' ? '📞' : kind === 'email' ? '✉️' : '🌐') + '</span>' +
        '<span class="tool-btn-label">' + esc(meta.action) + '</span></a>' +
      '<span class="tool-btn copy-chip" data-copy-value="' + escAttr(String(value)) + '" data-copy-msg="' + escAttr(meta.copied) + '">' +
        '<span class="tool-btn-icon">📋</span><span class="tool-btn-label">Скопировать</span></span>' +
      '</div>'
  });
}

/* Заполнение контактов — три коротких вопроса подряд, а не одна форма:
   модальное окно сайта умеет показывать одно поле за раз, а заводят их
   обычно все сразу, когда добавляют поставщика. Пустой ответ стирает
   поле — так его и убирают. */
async function setPurchaseContacts(cat) {
  cat = cat || currentPurchaseCategory;
  if (!can('purchase.contacts')) { denyToast('purchase.contacts'); return; }
  var c = purchaseCategoryById(cat);
  if (!c) return;

  // Все три поля в одном окне: контакты заводят разом, когда добавляют
  // поставщика, и пошаговый опрос заставлял бы трижды подтверждать
  // одно действие, а ради исправления опечатки — проходить его заново.
  var res = await showModal({
    title: '📇 Контакты — ' + c.label,
    message: 'Заполните то, что известно. Пустое поле просто не будет показываться.',
    withFields: [
      { key: 'phone', label: '📞 Телефон', value: c.phone || '', placeholder: '+38 067 123 45 67', inputType: 'tel' },
      { key: 'email', label: '✉️ Почта', value: c.email || '', placeholder: 'zakaz@postavshik.ua', inputType: 'email' },
      { key: 'site', label: '🌐 Сайт', value: c.site || '', placeholder: 'postavshik.ua' }
    ],
    okText: '💾 Сохранить'
  });
  if (res === null) return;

  c.phone = res.phone || '';
  c.email = res.email || '';
  c.site = res.site || '';
  stampEdit(c, 'изменил контакты');

  savePurchaseData();
  logActivity('изменил контакты поставщика', 'Закупка · ' + venueLabel(currentVenueId()), c.label +
    ': ' + (purchaseContacts(c).map(function(x) { return x.icon + ' ' + x.text; }).join(', ') || 'очищены'));
  updatePurchaseTemplateControls();
  renderPurchaseHomeList();
  renderPurchaseDetailContacts();
  schedulePurchaseSync();
  var filled = purchaseContacts(c).length;
  showToast(filled ? '✅ Контакты сохранены (' + filled + ')' : '✅ Контакты очищены');
}

/* Блок контактов на экране открытого цеха/поставщика. */
function renderPurchaseDetailContacts() {
  var holder = $('purchase-detail-contacts');
  if (!holder) return;
  holder.innerHTML = purchaseContactsHtml(purchaseCategoryById(currentPurchaseCategory), 'purchase-contacts-detail');
}

/* Ссылка на чат/группу/личку поставщика или цеха (Telegram, Viber,
   WhatsApp, любой другой сервис — принимаем как есть, ссылка не
   проверяется на конкретный формат конкретного мессенджера). Используется
   кнопкой "📤 Отправить всё" на главной странице "Закупки" — см.
   startSendAllPurchase(): по ней открывается чат, а в буфер обмена
   заранее копируется текст отчёта именно этой категории. Если ссылка
   введена без схемы (например просто "t.me/moya_gruppa" или
   "wa.me/79991234567") — по умолчанию подставляем "https://", чтобы
   window.open() не пытался открыть её как относительный адрес на самом
   сайте. */
function setPurchaseContactLink(cat) {
  cat = cat || currentPurchaseCategory;
  if (!can('purchase.contacts')) { denyToast('purchase.contacts'); return; }
  var c = purchaseCategoryById(cat);
  if (!c) return;
  customPrompt(
    'Ссылка на группу или личный чат для отправки закупки — Telegram, Viber, WhatsApp и т.п. (можно оставить пустым, чтобы убрать):',
    c.link || '', '🔗 Ссылка для отправки — ' + c.label
  ).then(function(val) {
    if (val === null) return;
    val = (val || '').trim();
    if (val && !/^[a-z][a-z0-9+.-]*:/i.test(val)) val = 'https://' + val; // без схемы — считаем обычной https-ссылкой
    c.link = val;
    stampEdit(c, 'изменил ссылку для отправки'); // без отметки правку затрёт отстающая копия
    savePurchaseData();
    updatePurchaseTemplateControls();
    renderPurchaseHomeList();
    schedulePurchaseSync();
    showToast(val ? '🔗 Ссылка сохранена' : '🔗 Ссылка убрана');
  });
}

/* Удаляет цех (builtin:true) или поставщика (builtin:false) — включая
   исходные "Пицца бар"/"Горячий цех": они больше ничем не защищены и
   удаляются точно так же, как любой цех/поставщик, добавленный позже,
   без возможности отмены и без автоматического восстановления при
   следующей загрузке или синхронизации с GitHub. При удалении цеха все
   поставщики, которые были к нему привязаны, не удаляются — просто
   теряют привязку (становятся "без привязки к цеху"). Если удаляется
   последняя оставшаяся категория (и цехов, и поставщиков больше не
   остаётся), возвращаем стартовый набор "Пицца бар"/"Горячий цех" —
   не как защиту конкретно этих двух, а просто чтобы раздел "Закупка"
   не остался вообще без единой категории. Вызывается как иконкой 🗑️
   на главной странице (без захода внутрь карточки), так и изнутри
   детального экрана — в обоих случаях после удаления возвращаемся на
   главную страницу. */
function removePurchaseCategory(cat) {
  cat = cat || currentPurchaseCategory;
  if (!can('purchase.structure')) { denyToast('purchase.structure'); return; }
  var c = purchaseCategoryById(cat);
  if (!c) return;
  var kind = c.builtin ? 'цех' : 'поставщика';
  var kindTitle = c.builtin ? 'Удалить цех' : 'Удалить поставщика';
  var extraWarning = c.builtin ? ' Все поставщики, привязанные к этому цеху, не удалятся — просто потеряют привязку.' : '';
  customConfirm('Удалить ' + kind + ' «' + c.label + '» вместе со всеми его позициями?' + extraWarning + ' Это действие нельзя отменить.', kindTitle).then(function(ok) {
    if (!ok) return;
    purchaseCategories = purchaseCategories.filter(function(x) { return x.id !== cat; });
    delete purchaseData[cat];
    if (c.builtin) {
      purchaseCategories.forEach(function(x) { if (!x.builtin && x.workshop === cat) x.workshop = ''; });
    }
    if (!purchaseCategories.length) {
      purchaseCategories = defaultPurchaseCategories();
      purchaseCategories.forEach(function(x) { if (!Array.isArray(purchaseData[x.id])) purchaseData[x.id] = []; });
    }
    ensurePurchaseCategoryOfVenue();
    savePurchaseData();
    showPurchaseHome();
    schedulePurchaseSync();
    showToast(c.builtin ? '🗑️ Цех удалён' : '🗑️ Поставщик удалён');
  });
}

/* Изменить (или снять) привязку уже существующего поставщика к заведению —
   доступно в любой момент, не только при создании. От этой привязки
   зависит, в общем списке и отчёте какого заведения появятся позиции
   этого поставщика — см. purchaseCategoriesForWorkshop(). */
function linkPurchaseSupplierWorkshop(cat) {
  cat = cat || currentPurchaseCategory;
  if (!can('purchase.structure')) { denyToast('purchase.structure'); return; }
  var c = purchaseCategoryById(cat);
  if (!c) return;
  if (c.builtin) { showToast('🔒 Цех уже сам является цехом — привязка не нужна'); return; }
  customSelect('К какому цеху относится поставщик «' + c.label + '»?', purchaseWorkshopOptions(), c.workshop || '', 'Привязать к цеху').then(function(workshop) {
    if (workshop === null) return; // отменили — ничего не меняем
    c.workshop = workshop;
    savePurchaseData();
    renderPurchaseHomeList();
    renderPurchaseList();
    schedulePurchaseSync();
    showToast(workshop ? '🔗 Поставщик привязан к цеху «' + purchaseCategoryLabel(workshop) + '»' : '🔗 Привязка к цеху снята');
  });
}

function addPurchaseRow(cat) {
  if (!(isAdmin() && purchaseTemplateEditMode)) { showToast('🔒 Чтобы добавлять позиции, сначала нажмите «✏️ Редактировать шаблон»'); return; }
  cat = cat || currentPurchaseCategory;
  var rows = purchaseRowsFor(cat);
  var row = { id: 'p' + Date.now() + Math.random().toString(36).slice(2, 7), name: '', unit: 'кг', norm: '', residual: '', reorder: '', reorderUnit: 'кг' };
  rows.push(row);
  savePurchaseData();
  renderPurchaseList();
  schedulePurchaseSync();
  showToast('➕ Ингредиент добавлен — впишите название');
  setTimeout(function() {
    var rowEl = document.querySelector('.purchase-row[data-id="' + row.id + '"]');
    var el = rowEl ? rowEl.querySelector('.purchase-name') : null;
    if (rowEl) {
      rowEl.classList.add('is-new');
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (el) el.focus();
  }, 30);
}

/* ================================================================
   ЗАГРУЗКА ПРАЙСА ОТ ПОСТАВЩИКА
   ================================================================
   Позволяет вместо ручного добавления позиций одной за другой загрузить
   файл прайса (xlsx/xls/csv/txt/pdf) и получить сразу все позиции —
   ровно по той же логике, что и ручное "+ Добавить ингредиент": каждая
   новая позиция получает название и ед. измерения из файла, а норму на
   неделю и остаток администратор вписывает потом сам вручную.
   Позиции, чьё название (без учёта регистра/лишних пробелов) уже есть в
   списке текущей категории, — пропускаются, чтобы не плодить дубли и не
   затирать уже вписанные недельные нормы у существующих строк. */

function triggerPurchaseImport() {
  if (!(isAdmin() && purchaseTemplateEditMode)) { showToast('🔒 Чтобы загрузить прайс, сначала нажмите «✏️ Редактировать шаблон»'); return; }
  var input = $('purchase-import-file');
  if (input) input.click();
}

async function handlePurchaseImportFile(file) {
  if (!file) return;
  if (!(isAdmin() && purchaseTemplateEditMode)) { showToast('🔒 Чтобы загрузить прайс, сначала нажмите «✏️ Редактировать шаблон»'); return; }
  showToast('⏳ Читаю файл...');
  var pairs;
  try {
    pairs = await parsePurchaseImportFile(file);
  } catch (e) {
    console.error('handlePurchaseImportFile error:', e);
    showToast('⚠️ Не удалось прочитать файл: ' + (e && e.message ? e.message : 'неизвестная ошибка'));
    return;
  }
  if (!pairs.length) {
    showToast('⚠️ Не нашёл позиций в файле — проверьте, что в нём есть названия товаров');
    return;
  }

  var cat = currentPurchaseCategory;
  var rows = purchaseRowsFor(cat);
  var existingNames = {};
  rows.forEach(function(r) { existingNames[normPurchaseName(r.name)] = true; });

  var added = 0, skipped = 0;
  var seenInFile = {}; // на случай, если один и тот же товар дважды встретился в самом файле
  pairs.forEach(function(p) {
    var key = normPurchaseName(p.name);
    if (!key || existingNames[key] || seenInFile[key]) { skipped++; return; }
    seenInFile[key] = true;
    existingNames[key] = true;
    rows.push({ id: 'p' + Date.now() + Math.random().toString(36).slice(2, 7), name: p.name.trim(), unit: p.unit || 'кг', norm: '', residual: '', reorder: '', reorderUnit: 'кг' });
    added++;
  });

  if (!added) {
    showToast('ℹ️ Все позиции из файла уже есть в списке (пропущено: ' + skipped + ') — новых не добавлено');
    return;
  }

  savePurchaseData();
  purchaseTemplateEditMode = true; // сразу входим в режим редактирования — новым позициям нужно вписать норму
  renderPurchaseList();
  updatePurchaseTemplateControls();
  schedulePurchaseSync();
  showToast('📥 Добавлено новых позиций: ' + added + (skipped ? ' (уже было в списке: ' + skipped + ')' : '') + ' — впишите норму на неделю');
}

function purchaseImportExt(file) {
  var m = /\.([a-z0-9]+)$/i.exec(file.name || '');
  return m ? m[1].toLowerCase() : '';
}

async function parsePurchaseImportFile(file) {
  var ext = purchaseImportExt(file);
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return parsePurchaseSpreadsheet(file);
  if (ext === 'pdf') return parsePurchaseTextLines(await extractPdfText(file));
  return parsePurchaseTextLines(await file.text()); // txt и всё, что не распознали, — читаем как обычный текст
}

function parsePurchaseSpreadsheet(file) {
  return new Promise(function(resolve, reject) {
    if (!window.XLSX) { reject(new Error('Модуль чтения таблиц ещё не загрузился — подождите секунду и попробуйте снова')); return; }
    var reader = new FileReader();
    reader.onerror = function() { reject(new Error('Не удалось прочитать файл')); };
    reader.onload = function() {
      try {
        var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
        resolve(rowsToPurchasePairs(rows));
      } catch (e) { reject(e); }
    };
    reader.readAsArrayBuffer(file);
  });
}

/* Ищем колонку с названием и колонку с ед. измерения по заголовку;
   если заголовок не распознан (или его вовсе нет) — считаем, что
   название в колонке A, ед. измерения — в колонке B, и это уже данные,
   а не шапка таблицы. */
function rowsToPurchasePairs(rows) {
  rows = (rows || []).filter(function(r) { return r && r.some(function(c) { return String(c || '').trim() !== ''; }); });
  if (!rows.length) return [];
  var header = rows[0].map(function(c) { return String(c || '').toLowerCase().trim(); });
  var foundName = header.findIndex(function(h) { return /назв|наимен|товар|позици|продукт|ингредиент|name/.test(h); });
  var foundUnit = header.findIndex(function(h) { return /^ед\b|единиц|ед\.?\s*изм|unit/.test(h); });
  var nameCol = 0, unitCol = 1, startRow = 0;
  if (foundName !== -1) { nameCol = foundName; unitCol = foundUnit !== -1 ? foundUnit : 1; startRow = 1; }
  var pairs = [];
  for (var i = startRow; i < rows.length; i++) {
    var row = rows[i];
    var name = String(row[nameCol] == null ? '' : row[nameCol]).trim();
    if (!name) continue;
    var unit = mapPurchaseUnit(unitCol < row.length ? row[unitCol] : '') || guessUnitFromText(name);
    pairs.push({ name: name, unit: unit || 'кг' });
  }
  return pairs;
}

/* Читает txt-файл или уже извлечённый из PDF текст построчно: одна
   строка — одна позиция. Понимает и "Название [таб/;] ед." (обычно так
   выглядит вставка из таблицы), и "Название кг" без разделителя. */
function parsePurchaseTextLines(text) {
  var pairs = [];
  String(text || '').split(/\r?\n/).forEach(function(line) {
    line = line.trim();
    if (!line) return;
    var parts = line.split(/\t|;|,(?!\d)/).map(function(s) { return s.trim(); }).filter(Boolean);
    var name = line, unit = null;
    if (parts.length >= 2) {
      var lastUnit = mapPurchaseUnit(parts[parts.length - 1]);
      if (lastUnit) { name = parts.slice(0, -1).join(' '); unit = lastUnit; }
    }
    var m = /^(.*?)[\s,]+(кг|г|гр|л|мл|шт|уп|кор|пач|бан|бут|вед|пак)\.?\s*$/i.exec(name);
    if (m && m[1].trim()) { name = m[1].trim(); if (!unit) unit = mapPurchaseUnit(m[2]); }
    if (!name) return;
    pairs.push({ name: name, unit: unit || guessUnitFromText(line) || 'кг' });
  });
  return pairs;
}

function guessUnitFromText(s) {
  var m = /(?:^|\s)(кг|г|гр|л|мл|шт|уп|кор|пач|бан|бут|вед|пак)\.?(?:\s|$)/i.exec(String(s || ''));
  return m ? mapPurchaseUnit(m[1]) : null;
}

// Список единиц измерения в карточке позиции — см. PURCHASE_BASE_UNITS
// (кг, г, л, мл, шт, бутылка, упаковка, ведро, банка). Распознаём
// сокращения/варианты написания из импортируемых прайсов и приводим их
// к одному из этих значений.
function mapPurchaseUnit(raw) {
  var s = String(raw == null ? '' : raw).toLowerCase().trim();
  if (!s) return null;
  if (/^(кг|kg)/.test(s)) return 'кг';
  if (/^(гр|g)/.test(s)) return 'г';
  if (/^г(?![а-яёa-z])/.test(s)) return 'г';
  if (/^(мл|ml)/.test(s)) return 'мл';
  if (/^л(?![а-яёa-z])/.test(s)) return 'л';
  if (/^(бут|bottle)/.test(s)) return 'бутылка';
  if (/^(вед|bucket)/.test(s)) return 'ведро';
  if (/^(бан|jar|can)/.test(s)) return 'банка';
  if (/^(уп|кор|пач|pack|box)/.test(s)) return 'упаковка';
  if (/^(шт|pcs?)/.test(s)) return 'шт';
  return null;
}

function normPurchaseName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/* Извлекает текст из PDF постранично, группируя фрагменты по Y-координате
   в строки — иначе pdf.js отдаёт текст страницы одним потоком без
   переносов, и разбить его на отдельные позиции прайса невозможно. */
async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error('Модуль чтения PDF ещё не загрузился — подождите секунду и попробуйте снова');
  var pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  var lines = [];
  for (var p = 1; p <= pdf.numPages; p++) {
    var content = await (await pdf.getPage(p)).getTextContent();
    var byY = {};
    content.items.forEach(function(it) {
      var y = Math.round(it.transform[5]);
      (byY[y] = byY[y] || []).push(it);
    });
    Object.keys(byY).map(Number).sort(function(a, b) { return b - a; }).forEach(function(y) {
      var lineText = byY[y].sort(function(a, b) { return a.transform[4] - b.transform[4]; })
        .map(function(it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim();
      if (lineText) lines.push(lineText);
    });
  }
  return lines.join('\n');
}

// "Сбросить остатки" — полный сброс перед началом новой недели: очищает
// ОДНОВРЕМЕННО поля "Остаток" (residual) И "Дозаказ" (reorder, вместе с
// единицей дозаказа reorderUnit, которая возвращается к значению по
// умолчанию "кг") у ВСЕХ позиций СРАЗУ ВО ВСЕХ цехах/поставщиках (весь
// purchaseData целиком — проходим по каждой категории как отдельному
// ключу). Название/ед. измерения/норму (шаблон) НЕ трогает — это удобно,
// чтобы затем просто вписать свежевзвешенные остатки поверх готового
// списка позиций, не создавая всё заново. Доступно и админу, и участнику
// с ролью "Закупка" (см. hasPurchaseAccess) — обычному гостю кнопка не
// видна вовсе (см. .purchase-access-only в CSS), а сюда, на всякий
// случай, добавлена ещё и проверка в самой функции. Кнопка есть и на
// главной странице "Закупки" (сбрасывает сразу всё, вне зависимости от
// того, в каком цехе/у какого поставщика открыта детальная страница), и
// внутри детального экрана конкретного цеха/поставщика — обе вызывают
// эту же функцию с одинаковым результатом.
async function resetAllPurchaseStock() {
  if (!hasPurchaseAccess()) { showToast('🔒 Сбрасывать остатки может только администратор или участник с ролью «Закупка»'); return; }
  var allCats = Object.keys(purchaseData);
  var totalRows = 0, rowsWithData = 0;
  allCats.forEach(function(cat) {
    purchaseRowsFor(cat).forEach(function(r) {
      totalRows++;
      if (purchaseRowIsTouched(r)) rowsWithData++;
    });
  });
  if (!rowsWithData) { showToast('Остатки и дозаказ уже пусты везде — сбрасывать нечего'); return; }
  var ok = await customConfirm('Полностью обнулить «Остаток» и «Дозаказ» у ВСЕХ позиций во ВСЕХ цехах и у ВСЕХ поставщиков (' + rowsWithData + ' из ' + totalRows + ' позиций)? Названия, единицы измерения и нормы останутся без изменений. Действие нельзя отменить.', '🧹 Сбросить остатки');
  if (!ok) return;
  allCats.forEach(function(cat) {
    purchaseRowsFor(cat).forEach(function(r) { r.residual = ''; r.reorder = ''; r.reorderUnit = 'кг'; });
  });
  savePurchaseData();
  renderPurchaseTab();
  showToast('✅ Остаток и дозаказ обнулены во всех цехах и у всех поставщиков — можно вписывать новые остатки');
}

function removePurchaseRow(cat, id) {
  if (!(isAdmin() && purchaseTemplateEditMode)) { showToast('🔒 Чтобы удалять позиции, сначала нажмите «✏️ Редактировать шаблон»'); return; }
  purchaseData[cat] = purchaseRowsFor(cat).filter(function(r) { return r.id !== id; });
  savePurchaseData();
  renderPurchaseList();
  schedulePurchaseSync();
}

// Поля "name"/"unit"/"norm" — это общий шаблон, их правят только
// владелец/администраторы, и правка уходит в GitHub (с debounce, чтобы
// не слать запрос на каждую нажатую клавишу). Поле "residual" (остаток)
// доступно всем и никуда, кроме этого браузера, не сохраняется.
var PURCHASE_TEMPLATE_FIELDS = { name: true, unit: true, norm: true };
function updatePurchaseField(cat, id, field, value) {
  if (PURCHASE_TEMPLATE_FIELDS[field] && !(isAdmin() && purchaseTemplateEditMode)) {
    showToast('🔒 Чтобы менять список и норму, сначала нажмите «✏️ Редактировать шаблон»');
    renderPurchaseList(); // откатываем поле в UI к сохранённому значению
    return;
  }
  var row = purchaseRowsFor(cat).find(function(r) { return r.id === id; });
  if (!row) return;
  row[field] = value;
  savePurchaseData();
  if (PURCHASE_TEMPLATE_FIELDS[field]) schedulePurchaseSync();
}

// Базовый набор единиц измерения для позиции закупки. Раньше был жёстко
// зашит только "кг"/"шт" — теперь администратор/разработчик (только в
// режиме редактирования шаблона, см. canEditTemplate) может добавить
// свою через пункт "+ своя…", и таких единиц может быть сколько угодно.
// Уже добавленные нестандартные единицы хранятся в общем синхронизируемом
// списке purchaseCustomUnits (см. выше) и поэтому одинаково доступны для
// выбора на ЛЮБОЙ позиции у ЛЮБОГО сотрудника — а не только там, где их
// когда-то ввели. currentUnit подмешивается отдельно на случай данных,
// сохранённых до появления общего списка (или гонки между вкладками), —
// чтобы <select> в любом случае корректно показывал текущее значение.
var PURCHASE_BASE_UNITS = ['кг', 'г', 'л', 'мл', 'шт', 'бутылка', 'упаковка', 'ведро', 'банка'];
function purchaseUnitOptionsHtml(currentUnit) {
  var units = PURCHASE_BASE_UNITS.slice();
  purchaseCustomUnits.forEach(function(u) { if (units.indexOf(u) === -1) units.push(u); });
  if (currentUnit && units.indexOf(currentUnit) === -1) units.push(currentUnit);
  var html = units.map(function(u) {
    return '<option value="' + escAttr(u) + '"' + (u === currentUnit ? ' selected' : '') + '>' + esc(u) + '</option>';
  }).join('');
  html += '<option value="__custom_unit__">+ своя…</option>';
  if (isAdmin() && purchaseTemplateEditMode && purchaseCustomUnits.length) {
    html += '<option value="__manage_units__">🗑 Управление единицами…</option>';
  }
  return html;
}

// Добавляет новую нестандартную единицу измерения в общий список
// (purchaseCustomUnits), синхронизируемый вместе с шаблоном закупки —
// благодаря этому единица, добавленная один раз на любой позиции, сразу
// становится доступна для выбора везде и у всех, а не только там, где
// её ввели. Базовые "кг"/"шт" сюда не попадают — они и так всегда есть.
function registerCustomUnit(unit) {
  unit = String(unit || '').trim();
  if (!unit || PURCHASE_BASE_UNITS.indexOf(unit) !== -1) return;
  if (purchaseCustomUnits.indexOf(unit) === -1) {
    purchaseCustomUnits.push(unit);
    savePurchaseData();
    // Единицу дозаказа (см. handlePurchaseReorderUnitChange) может добавить
    // ЛЮБОЙ сотрудник, не только администратор в режиме редактирования
    // шаблона, — а GitHub-синхронизация настроена только у администратора.
    // Поэтому пробуем отправить в общий список только если синхронизация
    // вообще настроена на этом устройстве; иначе просто оставляем единицу
    // локально (без пугающего тоста "настройте GitHub" на чужом устройстве).
    var cfg = getGithubConfig();
    if (cfg && cfg.token) schedulePurchaseSync();
  }
}

// Сколько позиций закупки (по всем цехам и поставщикам сразу) сейчас
// используют данную единицу измерения — нужно, чтобы не дать удалить из
// общего списка единицу, которая ещё где-то стоит: иначе у позиции
// осталось бы значение unit, отсутствующее в общем списке.
function purchaseUnitUsageCount(unit) {
  var count = 0;
  purchaseCategories.forEach(function(c) {
    // Считаем и основную единицу позиции (unit), и единицу дозаказа
    // (reorderUnit, см. handlePurchaseReorderUnitChange) — единица,
    // которая ещё где-то выбрана как единица дозаказа, тоже не должна
    // пропасть из общего списка молча.
    purchaseRowsFor(c.id).forEach(function(r) { if (r.unit === unit || r.reorderUnit === unit) count++; });
  });
  return count;
}

// Модалка управления общим списком нестандартных единиц измерения:
// показывает каждую единицу с числом позиций, где она сейчас используется,
// и позволяет удалить те, что больше не нужны. Удалить можно только
// единицу с использованием 0 — если она ещё где-то стоит, сначала нужно
// поменять её у соответствующих позиций (иначе значение "потеряется"
// незаметно). После каждого удаления модалка открывается заново — так
// можно убрать сразу несколько единиц подряд, пока не нажата "Готово".
async function manageCustomUnitsModal() {
  if (!purchaseCustomUnits.length) { showToast('ℹ️ Нестандартных единиц пока нет'); return; }
  var options = purchaseCustomUnits.map(function(u) {
    var n = purchaseUnitUsageCount(u);
    return { value: u, label: u + (n ? ' (используется: ' + n + ')' : ' (не используется)') };
  });
  var choice = await showModal({
    title: '🗑 Управление единицами',
    message: 'Выберите единицу, которую нужно удалить из общего списка (можно удалить только те, что нигде не используются):',
    withSelect: true,
    selectOptions: options,
    okText: 'Удалить',
    cancelText: 'Готово'
  });
  if (!choice) return; // нажали "Готово"/закрыли модалку
  if (purchaseUnitUsageCount(choice) > 0) {
    showToast('⚠️ Единица «' + choice + '» ещё используется — сначала измените её у соответствующих позиций');
    return manageCustomUnitsModal();
  }
  purchaseCustomUnits = purchaseCustomUnits.filter(function(u) { return u !== choice; });
  savePurchaseData();
  schedulePurchaseSync();
  showToast('✅ Единица «' + choice + '» удалена из списка');
  return manageCustomUnitsModal();
}

// Обработчик выбора в селекте "Ед." строки закупки. При выборе "+ своя…"
// запрашивает текст через showModal() (свой HTML-диалог — обычный
// prompt() молча не работает на iOS в режиме "На экран Домой" и в
// Telegram-браузере) и регистрирует его в общем списке единиц; при выборе
// "🗑 Управление единицами…" открывает модалку удаления. При отмене/пустом
// вводе откатывает select к прежнему значению, ничего не сохраняя.
async function handlePurchaseUnitChange(select, cat, id) {
  var row = purchaseRowsFor(cat).find(function(r) { return r.id === id; });
  var prevUnit = row ? row.unit : 'кг';
  if (select.value === '__manage_units__') {
    select.value = prevUnit;
    await manageCustomUnitsModal();
    renderPurchaseList();
    return;
  }
  if (select.value !== '__custom_unit__') {
    updatePurchaseField(cat, id, 'unit', select.value);
    recomputePurchaseRow(id);
    return;
  }
  var custom = await showModal({
    title: 'Своя единица измерения',
    message: 'Введите свою единицу измерения (например: л, уп, банка):',
    withInput: true,
    placeholder: 'например: л'
  });
  custom = (custom || '').trim();
  if (!custom) {
    select.value = prevUnit;
    return;
  }
  registerCustomUnit(custom);
  updatePurchaseField(cat, id, 'unit', custom);
  renderPurchaseList(); // перерисовываем, чтобы select показал новую единицу как опцию
}

// Обработчик выбора в селекте единицы "🔁 Дозаказ" (reorderUnit) — полный
// аналог handlePurchaseUnitChange выше, но пишет в отдельное поле
// reorderUnit и, в отличие от единицы позиции (unit), доступен ВСЕМ
// сотрудникам, а не только администратору в режиме редактирования шаблона
// (сам инпут "Дозаказ" и так редактируется всеми — см. renderPurchaseList).
// Единица берётся из того же общего списка purchaseCustomUnits, что и для
// "Ед." — так единица, добавленная через любую из двух колонок, сразу
// становится доступна в обеих, а не только там, где её ввели.
async function handlePurchaseReorderUnitChange(select, cat, id) {
  var row = purchaseRowsFor(cat).find(function(r) { return r.id === id; });
  var prevUnit = row ? (row.reorderUnit || 'кг') : 'кг';
  if (select.value === '__manage_units__') {
    select.value = prevUnit;
    await manageCustomUnitsModal();
    renderPurchaseList();
    return;
  }
  if (select.value !== '__custom_unit__') {
    updatePurchaseField(cat, id, 'reorderUnit', select.value);
    return;
  }
  var custom = await showModal({
    title: 'Своя единица измерения',
    message: 'Введите свою единицу измерения (например: л, уп, банка):',
    withInput: true,
    placeholder: 'например: л'
  });
  custom = (custom || '').trim();
  if (!custom) {
    select.value = prevUnit;
    return;
  }
  registerCustomUnit(custom);
  updatePurchaseField(cat, id, 'reorderUnit', custom);
  renderPurchaseList(); // перерисовываем, чтобы select показал новую единицу как опцию (в т.ч. в общем списке цеха)
}

// Округление "в выгодную сторону" = до ближайшего целого числа:
// 12,1 → 12 (округление вниз), 12,6 → 13 (округление вверх).
function roundToBuy(value) {
  if (!isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

function computeToBuy(row) {
  var norm = parseFloat(String(row.norm == null ? '' : row.norm).replace(',', '.'));
  if (!isFinite(norm)) return null;
  // Пустой "Остаток" значит "ещё не взвесили", а не "на складе 0" — это
  // разные вещи. Раньше пустое поле молча превращалось в 0, из-за чего
  // ВСЕ ещё не заполненные позиции считались нуждающимися в докупке на
  // полную норму (см. buildPurchaseReportLines) — а не только те, где
  // человек реально вписал 0. Явный 0, который вписан вручную, наоборот,
  // обязан считаться настоящим нулевым остатком и участвовать в расчёте.
  var residualStr = String(row.residual == null ? '' : row.residual).trim();
  if (residualStr === '') return null; // остаток не вписан — докупить неизвестно, не 0
  var residual = parseFloat(residualStr.replace(',', '.'));
  if (!isFinite(residual)) return null;
  var diff = norm - residual;
  if (diff <= 0) return 0;
  return roundToBuy(diff);
}

// Была ли позиция реально "тронута" пользователем — вписан остаток или
// дозаказ. В отличие от computeToBuy() (которому для расчёта нужна ещё и
// норма), это НЕ учитывает норму вовсе: пустые поля здесь не значат "нужно
// купить всё" — они просто не участвуют. Используется как единый критерий
// вместе с resetAllPurchaseStock() — чтобы кнопка "📤 Отправить всё
// поставщикам" пропадала сразу после "🧹 Сбросить остатки" (когда все поля
// ещё пустые) и появлялась заново только тогда, когда в остаток/дозаказ
// реально что-то вписали, а не просто из-за того, что где-то задана норма.
function purchaseRowIsTouched(r) {
  var hasResidual = r.residual !== undefined && r.residual !== null && String(r.residual) !== '';
  var hasReorder = r.reorder !== undefined && r.reorder !== null && String(r.reorder) !== '';
  return hasResidual || hasReorder;
}

function purchaseCategoryHasTouchedData(cat) {
  return purchaseRowsFor(cat).some(purchaseRowIsTouched);
}

function purchaseResultDisplay(row) {
  var toBuy = computeToBuy(row);
  if (toBuy === null) return { text: '—', cls: '' };
  if (toBuy <= 0) return { text: '✅ хватает', cls: 'purchase-result-ok' };
  return { text: toBuy + ' ' + row.unit, cls: 'purchase-result-need' };
}

/* Поля "Норма"/"Остаток"/"Дозаказ" — числовые и обычно короткие (1-3
   символа), но раньше растягивались на всю ширину своей колонки грида
   (см. историю в styles.css), из-за чего вокруг одной цифры оставалось
   много пустого места. Теперь ширина поля считается по факту введённого
   текста (или, если поле пустое, по подсказке-плейсхолдеру) и обновляется
   при каждом нажатии клавиши — так поле остаётся компактным, но растёт
   по мере набора более длинного числа. Вызывается как из oninput каждого
   такого поля, так и один раз после отрисовки списка (для уже
   заполненных значений).
   Ширина ставится через calc(...ch + 16px), а не просто в "ch", потому
   что у всего приложения box-sizing: border-box (см. styles.css) — при
   нём "width" уже включает в себя padding поля (8px слева + 8px справа
   = 16px), и если посчитать только под цифры, эти 16px откусывались бы
   от места для самих цифр (двузначная норма "14" превращалась в
   умещающуюся едва ли на одну цифру — видно было только "1"). Добавляя
   16px сверх ch, гарантируем, что под сами символы всегда остаётся
   ровно ch — вне зависимости от box-sizing. */
function autosizePurchaseInput(el) {
  if (!el) return;
  var val = (el.value !== '' && el.value != null) ? String(el.value) : (el.getAttribute('placeholder') || '');
  var ch = Math.max(2, Math.min(val.length + 1, 10));
  el.style.width = 'calc(' + ch + 'ch + 16px)';
}

function autosizeAllPurchaseInputs(root) {
  (root || document).querySelectorAll('.purchase-field input[type="number"]').forEach(autosizePurchaseInput);
}

// Проверяет, подходит ли название позиции под поисковый запрос —
// ищем ТОЛЬКО по началу слова ("по первым буквам"), а не по любому
// вхождению внутри названия, поэтому "как" не найдёт "Сахар".
// Проверяем и начало всего названия целиком, и начало каждого его
// слова отдельно — так многословные названия ("Сыр Пармезан")
// находятся по началу любого из слов, а не только первого.
function purchaseNameMatchesSearch(name, query) {
  if (!query) return true;
  var n = (name || '').trim().toLowerCase();
  if (!n) return false;
  if (n.indexOf(query) === 0) return true;
  return n.split(/\s+/).some(function(word) { return word.indexOf(query) === 0; });
}

function handlePurchaseSearchInput() {
  toggleSearchClear('purchase-search-positions');
  renderPurchaseList();
}

function clearPurchaseSearchInput() {
  var input = $('purchase-search-positions');
  if (!input) return;
  input.value = '';
  toggleSearchClear('purchase-search-positions');
  input.focus();
  renderPurchaseList();
}

function renderPurchaseList() {
  var holder = $('purchase-list');
  if (!holder) return;
  updatePurchaseCombinedSectionVisibility();
  var rows = purchaseRowsFor(currentPurchaseCategory);
  var canEditTemplate = isAdmin() && purchaseTemplateEditMode;

  updatePurchaseTemplateControls();

  var addBtn = $('purchase-add-btn');
  if (addBtn) addBtn.style.display = canEditTemplate ? '' : 'none';
  var hint = $('purchase-hint');
  if (hint) {
    hint.textContent = canEditTemplate
      ? '🧮 Режим редактирования включён: правьте название/ед./норму — изменения сохранятся автоматически, а кнопка «💾 Сохранить шаблон» отправит их в GitHub сразу. Впишите также норму на неделю, чтобы калькулятор посчитал, сколько докупить.'
      : (isAdmin()
        ? '🧮 Впишите остаток, который взвесили на месте, — калькулятор посчитает, сколько докупить. Чтобы поменять список позиций или норму, нажмите «✏️ Редактировать шаблон» выше.'
        : '🧮 Список составлен администратором. Впишите остаток, который взвесили на месте, — калькулятор посчитает, сколько докупить, округляя до ближайшего целого числа (например, 12,1 → 12, а 12,6 → 13).');
  }

  var searchWrap = $('purchase-search-wrap');
  if (searchWrap) searchWrap.style.display = rows.length ? '' : 'none';

  if (!rows.length) {
    holder.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:26px 10px">' +
      (canEditTemplate ? 'Пока нет ни одного ингредиента. Нажмите «+ Добавить ингредиент», чтобы начать закупку на неделю.' : 'Список пока пуст — дождитесь, пока администратор его составит.') + '</p>';
    updatePurchaseSummary();
    renderPurchaseCombinedList();
    return;
  }

  // Поиск позиции по названию — ищет по первым буквам (например, "мол"
  // найдёт "Молоко", но не "Пармезан"), проверяя как начало всего
  // названия, так и начало каждого отдельного слова в нём (чтобы
  // "Сыр Пармезан" находился и по "сыр", и по "пар"). Сам расчёт
  // (updatePurchaseSummary и т.д.) считается по ПОЛНОМУ списку rows —
  // фильтр влияет только на то, что видно на экране.
  var searchQuery = (($('purchase-search-positions') || {}).value || '').trim().toLowerCase();
  var visibleRows = searchQuery
    ? rows.filter(function(r) { return purchaseNameMatchesSearch(r.name, searchQuery); })
    : rows;

  if (searchQuery && !visibleRows.length) {
    holder.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:26px 10px">Ничего не найдено по запросу «' + esc($('purchase-search-positions').value.trim()) + '».</p>';
    updatePurchaseSummary();
    renderPurchaseCombinedList();
    return;
  }

  var cat = currentPurchaseCategory;
  holder.innerHTML = visibleRows.map(function(row) {
    var res = purchaseResultDisplay(row);
    var ro = canEditTemplate ? '' : ' readonly';
    var dis = canEditTemplate ? '' : ' disabled';
    var reorderUnit = row.reorderUnit || 'кг';
    return '<div class="purchase-row" data-id="' + row.id + '">' +
      '<div class="purchase-row-top">' +
        '<input type="text" class="purchase-name" placeholder="Название, например: Салями" value="' + escAttr(row.name) + '"' + ro + ' ' +
          'oninput="updatePurchaseField(\'' + cat + '\',\'' + row.id + '\',\'name\',this.value)">' +
        (canEditTemplate ? '<button type="button" class="purchase-remove" title="Удалить" onclick="removePurchaseRow(\'' + cat + '\',\'' + row.id + '\')">✕</button>' : '') +
      '</div>' +
      '<div class="purchase-row-fields">' +
        '<label class="purchase-field purchase-field-unit"><span>Ед.</span>' +
          '<select class="purchase-unit"' + dis + ' onchange="handlePurchaseUnitChange(this,\'' + cat + '\',\'' + row.id + '\')">' +
            purchaseUnitOptionsHtml(row.unit) +
          '</select>' +
        '</label>' +
        '<label class="purchase-field"><span>Норма (неделя)</span>' +
          '<input type="number" inputmode="decimal" step="any" min="0" class="purchase-norm" placeholder="14" value="' + escAttr(row.norm) + '"' + ro + ' ' +
            'oninput="autosizePurchaseInput(this); updatePurchaseField(\'' + cat + '\',\'' + row.id + '\',\'norm\',this.value); recomputePurchaseRow(\'' + row.id + '\')">' +
        '</label>' +
        '<label class="purchase-field"><span>Остаток</span>' +
          '<input type="number" inputmode="decimal" step="any" min="0" class="purchase-residual" placeholder="2.3" value="' + escAttr(row.residual) + '" ' +
            'oninput="autosizePurchaseInput(this); updatePurchaseField(\'' + cat + '\',\'' + row.id + '\',\'residual\',this.value); recomputePurchaseRow(\'' + row.id + '\')">' +
        '</label>' +
        '<div class="purchase-field"><span>Докупить</span>' +
          '<div class="purchase-result ' + res.cls + '" data-result-for="' + row.id + '">' + res.text + '</div>' +
        '</div>' +
        '<label class="purchase-field purchase-field-reorder"><span>🔁 Дозаказ</span>' +
          '<div class="purchase-reorder-group">' +
            '<input type="number" inputmode="decimal" step="any" min="0" class="purchase-reorder" placeholder="1" value="' + escAttr(row.reorder) + '" ' +
              'oninput="autosizePurchaseInput(this); updatePurchaseField(\'' + cat + '\',\'' + row.id + '\',\'reorder\',this.value)">' +
            '<select class="purchase-reorder-unit" onchange="handlePurchaseReorderUnitChange(this,\'' + cat + '\',\'' + row.id + '\')">' +
              purchaseUnitOptionsHtml(reorderUnit) +
            '</select>' +
          '</div>' +
        '</label>' +
      '</div>' +
    '</div>';
  }).join('');

  updatePurchaseSummary();
  renderPurchaseCombinedList();
  autosizeAllPurchaseInputs(holder);
}

/* ================================================================
   ОБЩИЙ СПИСОК (цех + все его поставщики, для обхода конкретного цеха)
   ================================================================
   Раньше, чтобы вписать остатки у всех поставщиков, приходилось по
   очереди переключаться между вкладками-чипами наверху. Этот блок
   показывает позиции самого цеха и ВСЕХ поставщиков, привязанных
   именно к нему (см. purchaseCategoriesForWorkshop), одним сплошным
   списком, БЕЗ разбивки по поставщику — при обходе цеха не важно,
   чей это поставщик, важно пройтись по всем позициям подряд сверху
   вниз. Поставщики, привязанные к другому цеху или вообще без
   привязки, сюда не попадают — у них есть своя отдельная вкладка-чип.
   Название/ед./норма тут только для чтения (шаблон правится в разделе
   конкретного поставщика) — редактируется только остаток, и это
   доступно всем, не только администратору. Позиция, добавленная
   поставщику выше, попадает сюда автоматически при следующей
   перерисовке (см. вызов renderPurchaseCombinedList() в конце
   renderPurchaseList()). */
function renderPurchaseCombinedList() {
  var holder = $('purchase-combined-list');
  if (!holder) return;

  var cats = purchaseCategoriesForWorkshop(currentPurchaseCategory);
  var allRows = [];
  cats.forEach(function(c) {
    purchaseRowsFor(c.id).forEach(function(row) {
      if ((row.name || '').trim()) allRows.push({ catId: c.id, row: row });
    });
  });

  if (!allRows.length) {
    holder.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:26px 10px">Пока нет ни одной позиции ни у этого цеха, ни у привязанных к нему поставщиков — добавьте позиции выше или привяжите поставщика к этому цеху («🔗 Привязать к цеху» в режиме редактирования шаблона).</p>';
    updatePurchaseCombinedSummary();
    return;
  }

  holder.innerHTML = allRows.map(function(entry) {
    var catId = entry.catId;
    var row = entry.row;
    var res = purchaseResultDisplay(row);
    var reorderUnit = row.reorderUnit || 'кг';
    return '<div class="purchase-row" data-id="' + row.id + '">' +
      '<div class="purchase-row-readonly-name">' + esc(row.name) +
        '<span class="purchase-row-meta">норма: ' + (row.norm === '' || row.norm == null ? '—' : esc(String(row.norm))) + ' ' + esc(row.unit) + '</span>' +
      '</div>' +
      '<div class="purchase-row-fields purchase-row-fields-combined">' +
        '<label class="purchase-field"><span>Остаток</span>' +
          '<input type="number" inputmode="decimal" step="any" min="0" class="purchase-residual" placeholder="2.3" value="' + escAttr(row.residual) + '" ' +
            'oninput="autosizePurchaseInput(this); updatePurchaseField(\'' + catId + '\',\'' + row.id + '\',\'residual\',this.value); recomputePurchaseRow(\'' + row.id + '\')">' +
        '</label>' +
        '<div class="purchase-field"><span>Докупить</span>' +
          '<div class="purchase-result ' + res.cls + '" data-result-for="' + row.id + '">' + res.text + '</div>' +
        '</div>' +
        '<label class="purchase-field purchase-field-reorder"><span>🔁 Дозаказ</span>' +
          '<div class="purchase-reorder-group">' +
            '<input type="number" inputmode="decimal" step="any" min="0" class="purchase-reorder" placeholder="1" value="' + escAttr(row.reorder) + '" ' +
              'oninput="autosizePurchaseInput(this); updatePurchaseField(\'' + catId + '\',\'' + row.id + '\',\'reorder\',this.value)">' +
            '<select class="purchase-reorder-unit" onchange="handlePurchaseReorderUnitChange(this,\'' + catId + '\',\'' + row.id + '\')">' +
              purchaseUnitOptionsHtml(reorderUnit) +
            '</select>' +
          '</div>' +
        '</label>' +
      '</div>' +
    '</div>';
  }).join('');

  updatePurchaseCombinedSummary();
  autosizeAllPurchaseInputs(holder);
}

function updatePurchaseCombinedSummary() {
  var el = $('purchase-combined-summary');
  if (!el) return;
  var cats = purchaseCategoriesForWorkshop(currentPurchaseCategory);
  var all = [];
  cats.forEach(function(c) {
    purchaseRowsFor(c.id).forEach(function(r) { if ((r.name || '').trim()) all.push(r); });
  });
  var needCount = 0;
  all.forEach(function(r) { var t = computeToBuy(r); if (t !== null && t > 0) needCount++; });
  el.textContent = all.length ? ('Нужно докупить: ' + needCount + ' из ' + all.length + ' позиций (цех + его поставщики)') : '';
}

/* Находит строку по её id независимо от того, в какой категории/у
   какого поставщика она числится — нужно, потому что "Общий список"
   показывает позиции разных поставщиков вперемешку, а у каждой строки
   есть только id, без привязки к текущей выбранной категории. */
function findPurchaseRowById(id) {
  for (var i = 0; i < purchaseCategories.length; i++) {
    var cat = purchaseCategories[i].id;
    var row = purchaseRowsFor(cat).find(function(r) { return r.id === id; });
    if (row) return row;
  }
  return null;
}

function recomputePurchaseRow(id) {
  var row = findPurchaseRowById(id);
  if (!row) return;
  var res = purchaseResultDisplay(row);
  // Одна и та же строка может быть отрисована сразу в двух местах —
  // в разделе своего поставщика и в "Общем списке" — обновляем оба.
  document.querySelectorAll('.purchase-result[data-result-for="' + id + '"]').forEach(function(el) {
    el.textContent = res.text;
    el.className = 'purchase-result ' + res.cls;
  });
  updatePurchaseSummary();
  updatePurchaseCombinedSummary();
}

function updatePurchaseSummary() {
  var el = $('purchase-summary');
  if (!el) return;
  var rows = purchaseRowsFor(currentPurchaseCategory);
  var withName = rows.filter(function(r) { return (r.name || '').trim(); });
  var needCount = 0;
  withName.forEach(function(r) { var t = computeToBuy(r); if (t !== null && t > 0) needCount++; });
  el.textContent = withName.length ? ('Нужно докупить: ' + needCount + ' из ' + withName.length + ' позиций') : '';
}

// Текст для поставщика должен содержать только то, что ему реально нужно —
// позицию и количество к заказу. Раньше сюда попадали служебные пометки
// ("норма не указана", "✅ хватает") и расчёт вёлся отдельно от дозаказа —
// поставщику это не нужно и только засоряет сообщение. Теперь:
//  - позиции, по которым ничего заказывать не нужно (норма не задана и
//    дозаказ не вписан, либо остатка достаточно и дозаказа нет), в отчёт
//    вообще не попадают;
//  - если норма/остаток дают количество к покупке И вписан дозаказ в той
//    же единице — они складываются в одно число;
//  - если единицы разные — показываются оба количества через "+".
function buildPurchaseReportData(cat) {
  var lines = [];
  var hasNormBased = false; // хотя бы одна позиция реально нуждается в докупке по норме (не дозаказ)
  var hasReorderOnly = false; // хотя бы одна позиция участвует ТОЛЬКО через "Дозаказ" (норма не задана/не нужна)
  purchaseRowsFor(cat).filter(function(r) { return (r.name || '').trim(); }).forEach(function(row) {
    var toBuy = computeToBuy(row); // null = норма не задана, 0 = хватает
    var needQty = (toBuy && toBuy > 0) ? toBuy : 0;
    var needUnit = row.unit;
    var reorderQty = parseFloat(String(row.reorder == null ? '' : row.reorder).replace(',', '.'));
    var hasReorder = isFinite(reorderQty) && reorderQty > 0;
    var reorderUnit = row.reorderUnit || 'кг';

    var qtyText;
    if (needQty > 0 && hasReorder) {
      hasNormBased = true;
      qtyText = (needUnit === reorderUnit)
        ? (needQty + reorderQty) + ' ' + needUnit
        : needQty + ' ' + needUnit + ' + ' + reorderQty + ' ' + reorderUnit;
    } else if (needQty > 0) {
      hasNormBased = true;
      qtyText = needQty + ' ' + needUnit;
    } else if (hasReorder) {
      hasReorderOnly = true;
      qtyText = reorderQty + ' ' + reorderUnit;
    } else {
      return; // нечего заказывать — поставщику эта строка не нужна
    }
    lines.push(row.name.trim() + ' — ' + qtyText);
  });

  // Заголовок отчёта должен отражать то, что реально вписано:
  // - только "Дозаказ" по всем позициям → "🔁 Дозаказ";
  // - только норма/остаток → "📦 Закупка на неделю";
  // - и то и другое вперемешку → "📦 Закупка на неделю + 🔁 дозаказ".
  var kind = 'normal';
  if (hasReorderOnly && hasNormBased) kind = 'both';
  else if (hasReorderOnly) kind = 'reorder';

  return { lines: lines, kind: kind };
}

function buildPurchaseReportLines(cat) {
  return buildPurchaseReportData(cat).lines;
}

function purchaseReportHeaderTitle(kind) {
  if (kind === 'reorder') return '🔁 Дозаказ';
  if (kind === 'both') return '📦 Закупка на неделю + 🔁 дозаказ';
  return '📦 Закупка на неделю';
}

/* Сообщение поставщику: приветствие с его именем и сам заказ.
   Служебной строки «📦 Закупка на неделю — Хорека (31.08.2026)» здесь
   намеренно нет: на какой срок мы считали — наша внутренняя кухня, а
   дата и так видна по времени сообщения. Имя поставщика при этом
   осталось: сообщения рассылаются по очереди, и по нему сразу видно,
   что письмо ушло тому, кому нужно. */
function buildPurchaseReportText(cat) {
  var data = buildPurchaseReportData(cat);
  // Имя поставщика — отдельной строкой под приветствием, а не в одну
  // строку с ним: так это читается как обращение, а не как «доброго
  // времени, компания такая-то».
  var head = 'Доброго времени!\n' + purchaseCategoryLabel(cat);
  if (!data.lines.length) return head + '\n\nНет позиций.';
  return head + '\n\n' + data.lines.join('\n');
}

function fallbackCopyText(text, successMsg) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showToast(successMsg || '📋 Скопировано в буфер обмена');
  } catch (e) {
    showToast('⚠️ Не удалось скопировать автоматически');
  }
  document.body.removeChild(ta);
}

function copyTextToClipboard(text, successMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      showToast(successMsg || '📋 Скопировано в буфер обмена');
    }).catch(function() { fallbackCopyText(text, successMsg); });
  } else {
    fallbackCopyText(text, successMsg);
  }
}

/* ================================================================
   ОТДЕЛЬНОЕ КОПИРОВАНИЕ ИМЕНИ И КОДА ОДНИМ НАЖАТИЕМ
   ================================================================
   Везде, где гостю показывают его имя и код устройства (заявка на
   доступ, экран ожидания одобрения), оба значения выводятся
   отдельными "чипами": нажатие на имя копирует только имя, нажатие
   на код — только код. Это удобнее, чем копировать всё сообщение
   целиком и вручную вырезать нужный кусок.
   Слушатель один на весь документ (делегирование), поэтому работает
   одинаково и в модальном окне, и на экране ожидания. ================================================================ */
document.addEventListener('click', function(e) {
  var chip = e.target.closest ? e.target.closest('.copy-chip') : null;
  if (!chip) return;
  var val = chip.getAttribute('data-copy-value') || '';
  var msg = chip.getAttribute('data-copy-msg') || '📋 Скопировано в буфер обмена';
  copyTextToClipboard(val, msg);
});

function copyChipHtml(icon, label, value, copiedMsg) {
  return '<span class="copy-chip" data-copy-value="' + escAttr(String(value)) + '" data-copy-msg="' + escAttr(copiedMsg) + '" ' +
    'style="display:inline-flex;align-items:center;gap:6px;margin:3px;padding:8px 14px;border-radius:10px;' +
    'background:var(--surface);border:1px solid var(--glass-border);cursor:pointer;font-weight:600;font-size:14px">' +
    icon + ' ' + esc(String(value)) + ' <span style="opacity:.6;font-size:12px">📋</span></span>';
}

/* Готовый блок "имя + код" с отдельным копированием каждого — используется
   и в приглашении отправить заявку в Telegram, и на экране ожидания. */
function buildNameCodeCopyHtml(name, code) {
  return '<div style="display:flex;flex-wrap:wrap;justify-content:center;margin:10px 0 4px">' +
    copyChipHtml('👤', 'Имя', name, '📋 Имя скопировано') +
    copyChipHtml('🔑', 'Код', code, '📋 Код устройства скопирован') +
    '</div>' +
    '<p style="text-align:center;font-size:11px;color:var(--text-muted);margin-top:0">Нажмите на имя или код, чтобы скопировать по отдельности</p>';
}

function copyPurchaseResult(cat) {
  cat = cat || currentPurchaseCategory;
  var text = buildPurchaseReportText(cat);
  copyTextToClipboard(text, '📋 Скопировано в буфер обмена');
}

/* ================================================================
   ДОЗАКАЗ — отдельный отчёт только по позициям, где вписано
   количество в колонке "🔁 Дозаказ", без привязки к обычному расчёту
   "норма минус остаток". Удобно, когда нужно докупить что-то сверх
   обычной недельной нормы (например, ждём гостей или расход вырос) —
   не нужно листать весь список, отчёт содержит только отмеченные позиции.
   ================================================================ */
function buildPurchaseReorderLines(cat) {
  return purchaseRowsFor(cat).filter(function(r) {
    return (r.name || '').trim() && String(r.reorder == null ? '' : r.reorder).trim();
  }).map(function(row) {
    return row.name.trim() + ' — ' + String(row.reorder).trim() + ' ' + (row.reorderUnit || 'кг');
  });
}

function buildPurchaseReorderReportText(cat) {
  var today = new Date().toLocaleDateString('ru-RU');
  var lines = buildPurchaseReorderLines(cat);
  var header = '🔁 Дозаказ — ' + purchaseCategoryLabel(cat) + ' (' + today + ')';
  if (!lines.length) return header + '\n\nНет позиций с указанным дозаказом.';
  return header + '\n\n' + lines.join('\n');
}

function copyPurchaseReorder(cat) {
  cat = cat || currentPurchaseCategory;
  var text = buildPurchaseReorderReportText(cat);
  copyTextToClipboard(text, '🔁 Дозаказ скопирован в буфер обмена');
}

function downloadPurchaseReorderText(cat) {
  cat = cat || currentPurchaseCategory;
  var text = buildPurchaseReorderReportText(cat);
  var blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'Дозаказ - ' + purchaseCategoryLabel(cat) + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

function downloadPurchaseReorderExcel(cat) {
  cat = cat || currentPurchaseCategory;
  if (typeof XLSX === 'undefined') {
    showToast('⚠️ Модуль Excel ещё загружается, попробуйте через секунду');
    return;
  }
  var rows = purchaseRowsFor(cat).filter(function(r) { return (r.name || '').trim() && String(r.reorder == null ? '' : r.reorder).trim(); });
  var data = [['Ингредиент', 'Ед. дозаказа', 'Дозаказ']];
  rows.forEach(function(row) {
    data.push([row.name.trim(), row.reorderUnit || 'кг', parseFloat(String(row.reorder).replace(',', '.'))]);
  });
  var ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 10 }];
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(purchaseCategoryLabel(cat), {}));
  XLSX.writeFile(wb, 'Дозаказ - ' + purchaseCategoryLabel(cat) + '.xlsx');
}

function buildAllPurchaseReorderReportText() {
  var today = new Date().toLocaleDateString('ru-RU');
  var cats = purchaseCategoriesForWorkshop(currentPurchaseCategory);
  var sections = cats.map(function(c) {
    var lines = buildPurchaseReorderLines(c.id);
    if (!lines.length) return null;
    return (c.icon || '📦') + ' ' + c.label + ':\n' + lines.join('\n');
  }).filter(function(s) { return s; });
  var header = '🔁 Дозаказ — ' + purchaseCategoryLabel(currentPurchaseCategory) + ' и его поставщики (' + today + ')';
  if (!sections.length) return header + '\n\nНет ни одной позиции с указанным дозаказом ни у цеха, ни у его поставщиков.';
  return header + '\n\n' + sections.join('\n\n');
}

function copyAllPurchaseReorder() {
  var text = buildAllPurchaseReorderReportText();
  copyTextToClipboard(text, '🔁 Дозаказ по цеху и его поставщикам скопирован');
}

function downloadAllPurchaseReorderText() {
  var text = buildAllPurchaseReorderReportText();
  var blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'Дозаказ - ' + purchaseCategoryLabel(currentPurchaseCategory) + ' (цех и поставщики).txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

function downloadAllPurchaseReorderExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('⚠️ Модуль Excel ещё загружается, попробуйте через секунду');
    return;
  }
  var wb = XLSX.utils.book_new();
  var usedNames = {};
  var any = false;
  purchaseCategoriesForWorkshop(currentPurchaseCategory).forEach(function(c) {
    var rows = purchaseRowsFor(c.id).filter(function(r) { return (r.name || '').trim() && String(r.reorder == null ? '' : r.reorder).trim(); });
    if (!rows.length) return;
    any = true;
    var data = [['Ингредиент', 'Ед. дозаказа', 'Дозаказ']];
    rows.forEach(function(row) {
      data.push([row.name.trim(), row.reorderUnit || 'кг', parseFloat(String(row.reorder).replace(',', '.'))]);
    });
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(c.label, usedNames));
  });
  if (!any) {
    showToast('⚠️ Нет ни одной позиции с указанным дозаказом ни у цеха, ни у его поставщиков');
    return;
  }
  XLSX.writeFile(wb, 'Дозаказ - все поставщики.xlsx');
}

function downloadPurchaseText(cat) {
  cat = cat || currentPurchaseCategory;
  var text = buildPurchaseReportText(cat);
  var blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'Закупка - ' + purchaseCategoryLabel(cat) + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

function downloadPurchaseExcel(cat) {
  cat = cat || currentPurchaseCategory;
  if (typeof XLSX === 'undefined') {
    showToast('⚠️ Модуль Excel ещё загружается, попробуйте через секунду');
    return;
  }
  var rows = purchaseRowsFor(cat).filter(function(r) { return (r.name || '').trim(); });
  var data = [['Ингредиент', 'Ед.', 'Норма (неделя)', 'Остаток', 'Докупить', 'Дозаказ']];
  rows.forEach(function(row) {
    var toBuy = computeToBuy(row);
    var reorderCell = (row.reorder === '' || row.reorder == null) ? '' : (String(row.reorder).trim() + ' ' + (row.reorderUnit || 'кг'));
    data.push([row.name.trim(), row.unit, row.norm === '' ? '' : parseFloat(String(row.norm).replace(',', '.')), row.residual === '' ? '' : parseFloat(String(row.residual).replace(',', '.')), toBuy === null ? '' : toBuy, reorderCell]);
  });
  var ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 30 }, { wch: 6 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(purchaseCategoryLabel(cat), {}));
  XLSX.writeFile(wb, 'Закупка - ' + purchaseCategoryLabel(cat) + '.xlsx');
}

/* Название листа Excel не может содержать : \ / ? * [ ], быть пустым,
   длиннее 31 символа или повторяться в одной книге — приводим к
   допустимому виду и, если совпало с уже занятым, добавляем "(2)", "(3)"... */
function sanitizeSheetName(name, used) {
  var base = String(name || 'Лист').replace(/[:\\\/\?\*\[\]]/g, ' ').trim().substring(0, 31) || 'Лист';
  var s = base, i = 1;
  while (used[s]) {
    i++;
    var suffix = ' (' + i + ')';
    s = base.substring(0, 31 - suffix.length) + suffix;
  }
  used[s] = true;
  return s;
}

/* ================================================================
   ОБЩИЙ ОТЧЁТ ПО ЦЕХУ И ЕГО ПОСТАВЩИКАМ
   ================================================================
   Когда остатки вписаны у нескольких поставщиков подряд, не нужно
   заходить в каждую вкладку по отдельности за своим результатом —
   эти функции собирают всё в один отчёт по цеху, который сейчас
   выбран (Пицца бар / Горячий цех) и всем поставщикам, привязанным
   именно к нему: каждая категория отдельным разделом (в тексте) или
   отдельным листом (в Excel), с уже готовым "сколько докупить" по
   каждой позиции. Пустые категории (без единой вписанной позиции) в
   отчёт не попадают.
   ================================================================ */
function buildAllPurchaseReportText() {
  var today = new Date().toLocaleDateString('ru-RU');
  var cats = purchaseCategoriesForWorkshop(currentPurchaseCategory);
  var sections = cats.map(function(c) {
    var lines = buildPurchaseReportLines(c.id);
    if (!lines.length) return null;
    return (c.icon || '📦') + ' ' + c.label + ':\n' + lines.join('\n');
  }).filter(function(s) { return s; });
  var header = '📦 Общая закупка на неделю — ' + purchaseCategoryLabel(currentPurchaseCategory) + ' и его поставщики (' + today + ')';
  if (!sections.length) return header + '\n\nНет ни одной позиции ни у цеха, ни у его поставщиков.';
  return header + '\n\n' + sections.join('\n\n');
}

function copyAllPurchaseResults() {
  var text = buildAllPurchaseReportText();
  copyTextToClipboard(text, '📋 Общий список по цеху и его поставщикам скопирован');
}

function downloadAllPurchaseText() {
  var text = buildAllPurchaseReportText();
  var blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'Закупка - ' + purchaseCategoryLabel(currentPurchaseCategory) + ' (цех и поставщики).txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

function downloadAllPurchaseExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('⚠️ Модуль Excel ещё загружается, попробуйте через секунду');
    return;
  }
  var wb = XLSX.utils.book_new();
  var usedNames = {};
  var any = false;
  purchaseCategoriesForWorkshop(currentPurchaseCategory).forEach(function(c) {
    var rows = purchaseRowsFor(c.id).filter(function(r) { return (r.name || '').trim(); });
    if (!rows.length) return;
    any = true;
    var data = [['Ингредиент', 'Ед.', 'Норма (неделя)', 'Остаток', 'Докупить', 'Дозаказ']];
    rows.forEach(function(row) {
      var toBuy = computeToBuy(row);
      var reorderCell = (row.reorder === '' || row.reorder == null) ? '' : (String(row.reorder).trim() + ' ' + (row.reorderUnit || 'кг'));
      data.push([row.name.trim(), row.unit, row.norm === '' ? '' : parseFloat(String(row.norm).replace(',', '.')), row.residual === '' ? '' : parseFloat(String(row.residual).replace(',', '.')), toBuy === null ? '' : toBuy, reorderCell]);
    });
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 30 }, { wch: 6 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(c.label, usedNames));
  });
  if (!any) {
    showToast('⚠️ Нет ни одной позиции ни у цеха, ни у его поставщиков');
    return;
  }
  XLSX.writeFile(wb, 'Закупка - ' + purchaseCategoryLabel(currentPurchaseCategory) + ' (цех и поставщики).xlsx');
}

/* ================================================================
   DETAIL VIEW
   ================================================================ */
function openDetail(id, autoplayVideo) {
  var r = null;
  for (var i = 0; i < recipes.length; i++) {
    if (recipes[i].id === id) { r = recipes[i]; break; }
  }
  if (!r) { showToast('Рецепт не найден'); return; }
  // Прямая ссылка на снятое с меню блюдо не должна обходить фильтр:
  // сотруднику показываем причину и возвращаем в список.
  if (!isRecipeVisibleForViewer(r)) {
    showToast('ℹ️ Этот рецепт сейчас не в меню');
    goToDefaultSection();
    return;
  }

  // Ссылкой на рецепт делятся в общих чатах, и открыть её может человек,
  // у которого сейчас выбрана другая точка. Молча показать карточку
  // нельзя: кнопка «назад» вела бы во вкладку, которой на экране нет.
  // Поэтому переводим на заведение рецепта — если оно человеку открыто.
  var recipeVenue = sectionVenueId(sectionById(recipeSectionId(r)) || {});
  if (recipeVenue !== currentVenueId()) {
    var allowed = venuesAvailableToMe().some(function(v) { return v.id === recipeVenue; });
    if (!allowed) {
      showToast('🔒 Этот рецепт из заведения, которое вам не открыто');
      goToDefaultSection();
      return;
    }
    currentVenue = recipeVenue;
    try { localStorage.setItem(CURRENT_VENUE_KEY, recipeVenue); } catch (e) {}
    var pcats = venuePurchaseCategories(recipeVenue);
    currentPurchaseCategory = pcats.length ? pcats[0].id : '';
    renderSectionNavTabs();
    refreshAllSectionLists();
    showToast('🏠 Открыто заведение «' + venueLabel(recipeVenue) + '»');
  }

  currentTab = 'detail';

  // Обновляем адресную строку — так на этот конкретный рецепт можно поделиться прямой ссылкой
  var shareUrl = location.pathname + location.search + '#recipe=' + encodeURIComponent(id);
  if (location.hash !== '#recipe=' + encodeURIComponent(id)) {
    history.pushState({ recipeId: id }, '', shareUrl);
  }

  // Возврат — в тот раздел, которому принадлежит рецепт (а не в один
  // общий список, как было, когда книга была одна на всё).
  var originTab = 'section:' + recipeSectionId(r);
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  var originTabEl = document.querySelector('.nav-tab[data-tab="' + originTab + '"]');
  if (originTabEl) originTabEl.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
  $('tab-detail').classList.add('active');
  window.scrollTo(0, 0);

  var backBtn = document.querySelector('.detail-back');
  if (backBtn) backBtn.setAttribute('onclick', "closeDetail('" + originTab + "')");
  var floatingBackBtn = $('detail-back-floating');
  if (floatingBackBtn) floatingBackBtn.setAttribute('onclick', "closeDetail('" + originTab + "')");

  var body = $('detail-body');
  body.innerHTML =
    (r.photo ? '<img class="detail-photo" src="' + escAttr(resolvePhotoSrc(r.photo)) + '" alt="" onclick="openPhotoLightbox(this.src)" style="cursor:zoom-in">' : '') +
    '<h2 class="detail-title">' + esc(r.name) + '</h2>' +
    '<div class="detail-meta">' +
      (recipeStatus(r) !== 'active' ? '<span class="detail-badge detail-badge-status">' + esc(statusMeta(recipeStatus(r)).icon + ' ' + statusMeta(recipeStatus(r)).label) + '</span>' : '') +
      (r.style ? '<span class="detail-badge">🏷 ' + esc(r.style) + '</span>' : '') +
      (r.time ? '<span class="detail-badge">⏱ Время: ' + r.time + ' мин</span>' : '') +
      (r.size ? '<span class="detail-badge">📐 Размер: ' + esc(r.size) + '</span>' : '') +
      (r.calories ? '<span class="detail-badge">🔥 Калорийность: ' + r.calories + ' ккал</span>' : '') +
      (r.weight ? '<span class="detail-badge">⚖️ Общий вес: ' + formatWeight(r.weight) + '</span>' : '') +
    '</div>' +

    // Кто и когда правил карточку. Видно всем, а не только админам:
    // повару тоже полезно знать, что норму меняли сегодня утром.
    (formatEditStamp(r) ? '<div class="edit-stamp">✏️ ' + esc(formatEditStamp(r)) + '</div>' : '') +

    // Тот же переключатель, что в списке: статус часто меняют, уже
    // открыв рецепт и убедившись, что это нужное блюдо.
    (can('recipe.status') ?
      '<div class="detail-status admin-only">' +
        '<span class="detail-status-title">Актуальность:</span>' +
        recipeStatusSwitchHtml(r) +
      '</div>' : '') +

    '<div class="section-title">Ингредиенты:</div>\n'
    + renderIngredientsCalc(r) +

    '<div class="section-title">Шаги приготовления:</div>\n'
    + '<ol class="steps-list">' +
      (r.steps.map ? r.steps.map(function(s) { return '<li onclick="this.classList.toggle(\'step-done\')">' + esc(s) + '</li>'; }).join('') : '') +
    '</ol>' +

    (getRecipeVideos(r).length ?
      '<div class="section-title">Видео:</div>\n' +
      getRecipeVideos(r).map(function(v) { return renderVideoBlock(v, !!autoplayVideo); }).join('')
      : '') +

    '<div class="qr-share-card">' +
      '<h3>📤 Поделиться этим рецептом</h3>' +
      '<p>Отсканируйте QR-код или отправьте ссылку — рецепт откроется сразу, без поиска в списке</p>' +
      '<div id="recipe-qr-canvas" class="qr-canvas-holder"></div>' +
      '<div class="qr-share-actions">' +
        '<a class="btn btn-telegram" id="telegram-share-btn" href="#" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><path d="M21.9 4.3 18.8 19.8c-.2 1-.9 1.3-1.7.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.7 13.1l-4.8-1.5c-1-.3-1-1 .2-1.5L20.6 3c.9-.3 1.6.2 1.3 1.3z"></path></svg>Telegram</a>' +
        '<button class="btn btn-ghost" onclick="shareRecipeLink(\'' + r.id + '\')">🔗 Скопировать ссылку</button>' +
      '</div>' +
    '</div>' +

    // Каждая кнопка показывается по своему праву: человеку могли открыть
    // правку, но закрыть удаление — тогда лишней кнопки быть не должно.
    '<!-- Actions (по правам участника) -->\n'
    + ((can('recipe.edit') || can('recipe.copy') || can('recipe.delete')) ?
      '<div class="tool-bar" style="margin-top:12px">' +
        (can('recipe.edit') ? '<button class="tool-btn tool-btn-primary" title="Редактировать рецепт" onclick="editFromDetail(\'' + r.id + '\')"><span class="tool-btn-icon">✏️</span><span class="tool-btn-label">Редактировать</span></button>' : '') +
        ((can('recipe.copy') && getVenues().length > 1) ? '<button class="tool-btn" title="Скопировать в другое заведение" onclick="copyRecipeToVenue(\'' + r.id + '\')"><span class="tool-btn-icon">📋</span><span class="tool-btn-label">В другое заведение</span></button>' : '') +
        ((can('recipe.edit') && r.photo) ? '<button class="tool-btn" title="Удалить фото из карточки" onclick="removeRecipePhoto(\'' + r.id + '\')"><span class="tool-btn-icon">🖼</span><span class="tool-btn-label">Убрать фото</span></button>' : '') +
        (can('recipe.delete') ? '<button class="tool-btn tool-btn-danger" title="Удалить рецепт" onclick="deleteRecipe(\'' + r.id + '\')"><span class="tool-btn-icon">🗑</span><span class="tool-btn-label">Удалить</span></button>' : '') +
      '</div>' : '');

  renderRecipeQR(r.id, r.name);
}

/* ================================================================
   ПРЯМЫЕ ССЫЛКИ НА РЕЦЕПТ (#recipe=ID в адресе страницы)
   ================================================================ */
function getRecipeShareUrl(id) {
  return location.origin + location.pathname + location.search + '#recipe=' + encodeURIComponent(id);
}

function renderRecipeQR(id, name) {
  var holder = $('recipe-qr-canvas');
  if (!holder) return;
  var url = getRecipeShareUrl(id);
  holder.innerHTML = '';

  if (window.QRCode) {
    try {
      new QRCode(holder, {
        text: url,
        width: 180,
        height: 180,
        colorDark: '#2b241e',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (e) {
      console.error('QR error:', e);
      holder.innerHTML = '<a href="' + escAttr(url) + '" style="color:#2b241e;font-size:13px;word-break:break-all">' + escAttr(url) + '</a>';
    }
  } else {
    // Библиотека не загрузилась (например нет интернета при первом открытии) —
    // показываем саму ссылку текстом, чтобы поделиться всё равно было можно
    holder.innerHTML = '<a href="' + escAttr(url) + '" style="color:#2b241e;font-size:13px;word-break:break-all">' + escAttr(url) + '</a>';
  }

  var tgBtn = $('telegram-share-btn');
  if (tgBtn) {
    var text = encodeURIComponent('🍕 ' + (name || 'Рецепт') + ' — Route 20');
    tgBtn.href = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + text;
  }
}

function shareRecipeLink(id) {
  var url = getRecipeShareUrl(id);
  copyTextToClipboard(url, '🔗 Ссылка скопирована');
}

function closeDetail(originTab) {
  // Убираем #recipe=... из адреса при выходе из детального просмотра
  history.pushState(null, '', location.pathname + location.search);
  var floatingBackBtn = $('detail-back-floating');
  if (floatingBackBtn) floatingBackBtn.classList.remove('show'); // не ждём IntersectionObserver — прячем сразу
  switchTab(originTab);
}

function openRecipeFromHash(isFinalAttempt) {
  var m = location.hash.match(/^#recipe=(.+)$/);
  if (!m) return;
  var id = decodeURIComponent(m[1]);
  var exists = recipes.some(function(r) { return r.id === id && isRecipeVisibleForViewer(r); });
  if (exists) {
    openDetail(id);
  } else if (isFinalAttempt) {
    showToast('⚠️ Рецепт по этой ссылке не найден (возможно, удалён)');
  }
}

window.addEventListener('popstate', function() {
  if (location.hash.indexOf('#recipe=') === 0) {
    openRecipeFromHash();
  } else if (currentTab === 'detail') {
    goToDefaultSection();
  }
});

function editFromDetail(id) {
  if (!can('recipe.edit')) { denyToast('recipe.edit'); return; }
  var r = null;
  for (var i = 0; i < recipes.length; i++) {
    if (recipes[i].id === id) { r = recipes[i]; break; }
  }
  if (!r) return;

  pendingAddSection = recipeSectionId(r);
  var recType = recipeCategoryById(r.type) ? r.type : firstCategoryIdForSection(pendingAddSection);
  pendingAddType = recType;
  // editingRecipe выставляем ДО switchTab('add') — так switchTab видит,
  // что это редактирование уже существующей карточки (а не создание
  // новой с нуля), и пропускает обычного (не-разработчика) админа.
  editingRecipe = JSON.parse(JSON.stringify(r)); // деep copy
  switchTab('add');

  renderTypeSelect();
  $('f-type').value = recType;
  onTypeChange();
  $('form-title').textContent = '✏️ Редактирование' + categoryTitleSuffix(recType);
  $('f-name').value = r.name;
  $('f-time').value = r.time || '';
  $('f-size').value = r.size || '';
  $('f-calories').value = r.calories || '';
  $('f-weight').value = r.weight || '';
  $('f-style').value = r.style || '';
  $('videos-list').innerHTML = '';
  getRecipeVideos(r).forEach(function(v) { addVideoRow(v); });

  currentPhotoData = r.photo;
  $('f-photo-data').value = r.photo || '';
  renderPhotoPreview(r.photo);

  $('ingredients-list').innerHTML = '';
  if (r.ingredients) {
    for (var j = 0; j < r.ingredients.length; j++) addIngredientRow(r.ingredients[j]);
  }

  $('steps-list').innerHTML = '';
  if (r.steps) {
    for (var k = 0; k < r.steps.length; k++) addStepRow(r.steps[k]);
  }
}

/* Удаление фото из уже сохранённого рецепта — прямо из его карточки,
   не открывая форму. Отдельный файл на GitHub при этом остаётся: он
   ничего не весит для сайта и может пригодиться, если фото удалили по
   ошибке, а ссылки на него в рецепте уже нет. */
async function removeRecipePhoto(id) {
  if (!can('recipe.edit')) { denyToast('recipe.edit'); return; }
  var r = null;
  for (var i = 0; i < recipes.length; i++) {
    if (recipes[i].id === id) { r = recipes[i]; break; }
  }
  if (!r) { showToast('⚠️ Рецепт не найден'); return; }
  if (!r.photo) { showToast('ℹ️ У этого рецепта нет фото'); return; }

  var ok = await customConfirm('Удалить фото из рецепта «' + r.name + '»?\n\nСам рецепт останется, изменится только карточка.', '🗑 Удалить фото');
  if (!ok) return;

  r.photo = null;
  stampEdit(r, 'удалил фото');
  if (!saveAll()) return;
  logActivity('удалил фото рецепта', sectionLabel(recipeSectionId(r)), r.name);
  refreshAllSectionLists();
  openDetail(id); // перерисовываем открытую карточку уже без фото
  showToast('🗑 Фото удалено');
}

/* Копирование рецепта в другое заведение.
   Точки ведут меню независимо, но половина карт у сети общая, и
   набивать «Маргариту» заново в каждой новой пиццерии — лишняя работа.
   Копия получает НОВЫЙ id: дальше это самостоятельный рецепт, правки в
   одном заведении не трогают другое. Так и договаривались — точки
   независимы, но переносить между ними можно одним нажатием. */
async function copyRecipeToVenue(id) {
  if (!can('recipe.copy')) { denyToast('recipe.copy'); return; }
  var r = null;
  for (var i = 0; i < recipes.length; i++) {
    if (recipes[i].id === id) { r = recipes[i]; break; }
  }
  if (!r) { showToast('⚠️ Рецепт не найден'); return; }

  var fromVenue = sectionVenueId(sectionById(recipeSectionId(r)) || {});
  var targets = getVenues().filter(function(v) { return v.id !== fromVenue; });
  if (!targets.length) { showToast('⚠️ Других заведений пока нет'); return; }

  var venueId = await customSelect(
    'В какое заведение скопировать «' + r.name + '»?',
    targets.map(function(v) { return { value: v.id, label: (v.icon ? v.icon + ' ' : '') + v.label }; }),
    targets[0].id,
    '📋 Копировать рецепт'
  );
  if (!venueId) return;

  var targetSections = sectionsForVenue(venueId);
  if (!targetSections.length) {
    showToast('⚠️ В «' + venueLabel(venueId) + '» ещё нет ни одного раздела — сначала создайте его');
    return;
  }
  var sectionId = await customSelect(
    'В какой раздел заведения «' + venueLabel(venueId) + '»?',
    targetSections.map(function(s) { return { value: s.id, label: (s.icon ? s.icon + ' ' : '') + s.label }; }),
    targetSections[0].id,
    '📋 Раздел назначения'
  );
  if (!sectionId) return;

  var targetCats = categoriesForSection(sectionId);
  if (!targetCats.length) {
    showToast('⚠️ В этом разделе ещё нет категорий — создайте хотя бы одну');
    return;
  }
  var catId = await customSelect(
    'В какую категорию положить копию?',
    targetCats.map(function(c) { return { value: c.id, label: (c.icon ? c.icon + ' ' : '') + c.label }; }),
    targetCats[0].id,
    '📋 Категория'
  );
  if (!catId) return;

  var copy = JSON.parse(JSON.stringify(r));
  copy.id = uid();
  copy.section = sectionId;
  copy.type = catId;
  // Размер задаётся списком категории, а у категории другого заведения
  // список свой — оставляем значение, только если оно там есть.
  var sizes = categorySizes(recipeCategoryById(catId));
  if (copy.size && sizes.length && sizes.indexOf(copy.size) === -1) copy.size = null;
  copy.status = 'active'; // в новой точке блюдо начинают вести как актуальное
  stampEdit(copy, 'скопировал из «' + venueLabel(fromVenue) + '»');

  recipes.push(copy);
  if (!saveAll()) return;
  logActivity('скопировал рецепт в другое заведение', venueLabel(venueId) + ' · ' + sectionLabel(sectionId), r.name);
  refreshAllSectionLists();
  showToast('✅ Копия создана в «' + venueLabel(venueId) + '» → ' + sectionLabel(sectionId));
}

async function deleteRecipe(id) {
  if (!can('recipe.delete')) { denyToast('recipe.delete'); return; }
  var ok = await customConfirm('Удалить этот рецепт?');
  if (!ok) return;
  var doomed = recipes.filter(function(r) { return r.id === id; })[0];
  recipes = recipes.filter(function(r) { return r.id !== id; });
  saveAll();
  if (doomed) logActivity('удалил рецепт', sectionLabel(recipeSectionId(doomed)), doomed.name);
  showToast('🗑 Рецепт удалён');
  goToDefaultSection();
}

/* ================================================================
   ОТПРАВКА ВСЕХ ОТЧЁТОВ ПОСТАВЩИКАМ/ЦЕХАМ ("📤 Отправить всё")
   ================================================================
   По кнопке на главной странице "Закупки" собираем все категории
   (цеха и поставщики), у которых указана ссылка (c.link) И есть хотя бы
   одна заполненная позиция, — и проводим по ним пошагово, одну за
   другой: копируем в буфер обмена текст отчёта именно этой категории и
   открываем её ссылку в новой вкладке. Полностью автоматическая отправка
   невозможна — ни Telegram, ни WhatsApp, ни Viber не позволяют сайту
   нажать "отправить" за человека, — поэтому после вставки текста в
   открывшемся чате человек сам жмёт отправить, возвращается сюда и жмёт
   "Отправил(а) → Далее", чтобы перейти к следующему. */
var sendAllPurchaseQueue = [];
var sendAllPurchaseIndex = 0;

/* Прогресс рассылки хранится в localStorage (id категорий по порядку +
   текущий индекс), чтобы при случайном закрытии вкладки/браузера
   посреди рассылки (например, после ухода в мессенджер отправлять
   отчёт) можно было вернуться в "Закупку" и продолжить с того же
   места, а не начинать заново. Пишем прогресс на каждый шаг
   (после "Отправил(а) → Далее" / "Пропустить") и стираем при
   завершении или явной отмене. */
var SEND_PURCHASE_PROGRESS_KEY = 'route20_send_purchase_progress';

function saveSendAllPurchaseProgress() {
  try {
    if (!sendAllPurchaseQueue.length) { localStorage.removeItem(SEND_PURCHASE_PROGRESS_KEY); return; }
    localStorage.setItem(SEND_PURCHASE_PROGRESS_KEY, JSON.stringify({
      ids: sendAllPurchaseQueue.map(function(c) { return c.id; }),
      index: sendAllPurchaseIndex
    }));
  } catch (e) {}
}

function loadSendAllPurchaseProgress() {
  try {
    var raw = localStorage.getItem(SEND_PURCHASE_PROGRESS_KEY);
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !Array.isArray(data.ids) || !data.ids.length) return null;
    // Оставляем только тех поставщиков/цеха, что всё ещё существуют и
    // сохранили ссылку для отправки (могли быть удалены/отредактированы
    // за время, пока рассылка была не завершена).
    var ids = data.ids.filter(function(id) {
      var c = purchaseCategoryById(id);
      return c && (c.link || '').trim();
    });
    if (!ids.length) return null;
    var index = typeof data.index === 'number' ? data.index : 0;
    if (index < 0) index = 0;
    if (index > ids.length) index = ids.length;
    return { ids: ids, index: index };
  }
  catch (e) { return null; }
}

function clearSendAllPurchaseProgress() {
  try { localStorage.removeItem(SEND_PURCHASE_PROGRESS_KEY); } catch (e) {}
}

function startSendAllPurchase() {
  // Рассылаем отчёты только текущего заведения: у каждой точки свои
  // поставщики и свои чаты.
  var candidates = venuePurchaseCategories().filter(function(c) {
    return (c.link || '').trim() && purchaseCategoryHasTouchedData(c.id) && buildPurchaseReportLines(c.id).length > 0;
  });
  if (!candidates.length) {
    showToast('⚠️ Нет ни одного поставщика/цеха со ссылкой для отправки и заполненными позициями');
    return;
  }
  sendAllPurchaseQueue = candidates;
  sendAllPurchaseIndex = 0;
  saveSendAllPurchaseProgress();
  renderSendAllPurchaseStep();
}

/* Продолжает рассылку с места, сохранённого в localStorage (баннер на
   главной странице "Закупки"). Если прогресс не восстанавливается
   (например, все сохранённые поставщики/цеха успели удалить или у них
   убрали ссылку), тихо начинает рассылку заново по актуальному списку. */
function resumeSendAllPurchase() {
  var progress = loadSendAllPurchaseProgress();
  if (!progress) { startSendAllPurchase(); return; }
  var queue = progress.ids.map(function(id) { return purchaseCategoryById(id); }).filter(Boolean);
  if (!queue.length) { clearSendAllPurchaseProgress(); startSendAllPurchase(); return; }
  sendAllPurchaseQueue = queue;
  sendAllPurchaseIndex = progress.index;
  saveSendAllPurchaseProgress();
  renderSendAllPurchaseStep();
}

/* "Начать заново" в баннере незавершённой рассылки — стирает сохранённый
   прогресс и запускает рассылку с нуля по актуальному списку. */
function discardSendAllPurchaseProgress() {
  clearSendAllPurchaseProgress();
  startSendAllPurchase();
}

function renderSendAllPurchaseStep() {
  var overlay = $('send-purchase-overlay');
  if (!overlay) return;
  var titleEl = $('send-purchase-title');
  var msgEl = $('send-purchase-message');
  var textEl = $('send-purchase-text');
  var stepActions = $('send-purchase-step-actions');
  var finishActions = $('send-purchase-finish-actions');
  var nextBtn = $('send-purchase-next-btn');

  // Все поставщики/цеха из очереди обработаны — вместо автоматического
  // закрытия показываем финальный шаг с явной кнопкой "Завершить закупку".
  // Пока пользователь её не нажал, можно передумать и просто закрыть
  // модалку крестиком/вне окна — прогресс останется сохранён (баннер
  // "Рассылка не завершена" на главной странице предложит вернуться сюда).
  if (sendAllPurchaseIndex >= sendAllPurchaseQueue.length) {
    if (titleEl) titleEl.textContent = '✅ Все поставщики и цеха обработаны (' + sendAllPurchaseQueue.length + ')';
    if (msgEl) msgEl.style.display = 'none';
    if (textEl) textEl.style.display = 'none';
    if (stepActions) stepActions.style.display = 'none';
    if (finishActions) finishActions.style.display = '';
    overlay.classList.add('show');
    return;
  }

  var c = sendAllPurchaseQueue[sendAllPurchaseIndex];
  if (titleEl) titleEl.textContent = '📤 Отправка ' + (sendAllPurchaseIndex + 1) + ' из ' + sendAllPurchaseQueue.length + ' — ' + (c.icon || '📦') + ' ' + c.label;
  if (msgEl) {
    msgEl.style.display = '';
    var needsPaste = !!resolvePurchaseAppLink(c.link, ' ').needsPaste;
    // Три случая: работает бот, приватная группа без бота, обычный чат.
    // Раньше здесь стоял return — он выходил бы из всей функции и шаг
    // остался бы без текста заказа и кнопок.
    if (canSendViaBot(c)) {
      msgEl.textContent = 'Нажмите «Отправить ботом» — заказ уйдёт в группу сразу, открывать Telegram не нужно. Мастер сам перейдёт к следующему поставщику.';
    } else if (needsPaste) {
      msgEl.textContent = 'У этого поставщика ссылка на группу — в неё Telegram текст не подставляет. Нажмите «Открыть чат» и вставьте заказ из буфера. Чтобы отправлять в группу одним нажатием, настройте бота: кнопка «🤖 Бот» в режиме редактирования шаблона. Затем «Отправил(а) → Далее».';
    } else {
      msgEl.textContent = 'Нажмите «Открыть чат» — заказ уже будет вписан в поле сообщения, останется проверить и отправить. Затем «Отправил(а) → Далее».';
    }
  }
  if (textEl) {
    textEl.style.display = '';
    textEl.value = buildPurchaseReportText(c.id);
    // Ссылка «Открыть чат» несёт текст внутри себя и готовится заранее,
    // поэтому её надо переписывать на каждую правку — иначе в чат
    // подставился бы заказ до редактирования.
    textEl.oninput = function() {
      // Элемент ищем здесь, а не берём из переменной снаружи: она
      // объявлена ниже по коду и на момент создания обработчика пуста.
      var linkBtn = $('send-purchase-copy-btn');
      if (!linkBtn) return;
      var fresh = resolvePurchaseAppLink(c.link, textEl.value.trim() || buildPurchaseReportText(c.id));
      linkBtn.href = fresh.url || '#';
    };
  }
  if (stepActions) stepActions.style.display = '';
  if (finishActions) finishActions.style.display = 'none';
  if (nextBtn) nextBtn.disabled = true; // сначала нужно нажать "Скопировать и открыть чат"

  // Ссылку на чат кладём в href НАСТОЯЩЕГО <a>-тега заранее (не в момент
  // клика), чтобы переход происходил как обычный тап по гиперссылке —
  // см. подробное объяснение над sendAllPurchaseOpenAndCopy ниже.
  var copyBtn = $('send-purchase-copy-btn');
  var shareBtn = $('send-purchase-share-btn');
  // Текст кладём в ссылку заранее, вместе с адресом чата: подставить
  // его в момент нажатия нельзя — переход должен идти по настоящему
  // href, иначе телефон не откроет приложение напрямую.
  var resolved = resolvePurchaseAppLink(c.link, buildPurchaseReportText(c.id));
  if (copyBtn) {
    copyBtn.href = resolved.url || '#';
    copyBtn.target = isMobileDevice() ? '_self' : '_blank';
  }
  if (shareBtn) shareBtn.style.display = 'none'; // кнопки больше нет в разметке, оставлено для старых вкладок

  // Кнопка настройки бота — прямо здесь. Тому, кто рассылает заказы,
  // незачем идти в режим редактирования шаблона (он ему и не открыт).
  var setupBtn = $('send-purchase-bot-setup-btn');
  if (setupBtn) setupBtn.style.display = (!getTelegramBotToken() && hasPurchaseAccess()) ? '' : 'none';

  var botBtn = $('send-purchase-bot-btn');
  if (botBtn) {
    var viaBot = canSendViaBot(c);
    botBtn.style.display = viaBot ? '' : 'none';
    botBtn.disabled = false;
    // Когда работает бот, открывать чат вручную не нужно — оставляем
    // эту кнопку запасной, но главной делаем отправку.
    if (copyBtn) copyBtn.className = viaBot ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm';
  }

  overlay.classList.add('show');
}

/* Простое определение телефона (а не десктопа) — на телефоне нужно
   переходить по ссылке поставщика в ЭТОЙ ЖЕ вкладке (см. ниже, почему),
   на десктопе — по-прежнему открывать в новой, чтобы не терять текущую
   страницу закупки. iPad с iPadOS 13+ представляется как Macintosh, но
   при этом имеет тачскрин — учитываем и это. */
function isMobileDevice() {
  var ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1; // iPadOS
}

/* Разбирает сохранённую ссылку поставщика/цеха (c.link) и приводит её к
   ссылке для перехода в чат С УЖЕ ВСТАВЛЕННЫМ текстом заказа.

   ПОЧЕМУ ТАК, ХОТЯ РАНЬШЕ БЫЛО ИНАЧЕ. Подстановку убирали: ссылка с
   ?text= — не прямая Universal Link, а промежуточная страница (t.me,
   wa.me), поэтому телефон при каждом переходе спрашивает «открыть
   приложение?». Но вставлять текст вручную в каждый из полутора
   десятков чатов — работа куда более утомительная, чем одно
   подтверждение. Так же устроен и запрос ключа у администратора, где
   текст подставляется сам и это никого не смущает.

   Текст при этом всё равно копируется в буфер (см.
   sendAllPurchaseOpenAndCopy): если приложение подстановку
   проигнорирует, останется просто вставить.
   Раньше для WhatsApp и личных чатов Telegram текст передавался прямо в
   ссылке (?text=...), но именно это и вызывало системное окно "Сайт
   пытается открыть другое приложение" при КАЖДОМ нажатии: ссылка с
   ?text= — это не прямая Universal Link, а промежуточная страница
   (wa.me / t.me), которая сама через свой скрипт передаёт управление
   приложению через кастомную схему (whatsapp://, tg://) — и вот этот
   шаг ОС подтверждает каждый раз, без возможности запомнить выбор.
   Обычная ссылка БЕЗ query-параметров — настоящая Universal Link:
   приложение открывается сразу, без промежуточной страницы и без
   всплывающего окна. Текст всё равно уже лежит в буфере обмена (см.
   copyTextToClipboard в sendAllPurchaseOpenAndCopy) — его нужно вставить
   вручную (Ctrl+V / зажать → «Вставить») в открывшемся чате. */
function resolvePurchaseAppLink(rawLink, text) {
  var link = (rawLink || '').trim();
  if (!link) return { url: link, prefilled: false };
  var body = encodeURIComponent(text || '');

  // WhatsApp: wa.me/<телефон> или (api.)whatsapp.com/send?phone=<телефон>
  var waMatch = link.match(/(?:wa\.me\/|whatsapp\.com\/send\?[^#]*phone=)(\d{6,15})/i);
  if (waMatch) {
    return { url: 'https://wa.me/' + waMatch[1] + (body ? '?text=' + body : ''), prefilled: !!body };
  }

  /* Telegram: t.me/<имя> — адресный чат (личный, публичная группа или
     канал с коротким именем). Сюда текст ПОДСТАВЛЯЕТСЯ параметром
     ?text= — это проверено на живом устройстве: ровно так работает
     кнопка «Запросить ключ у администратора», где сообщение приходит в
     чат уже вписанным.

     Не работает подстановка только с приглашениями t.me/+… — там чат
     заранее неизвестен (см. ветку ниже). */
  var tgMatch = link.match(/t(?:elegram)?\.me\/([a-zA-Z0-9_]{4,32})(?:[/?]|$)/i);
  if (tgMatch && !/t(?:elegram)?\.me\/(\+|joinchat\/|c\/)/i.test(link)) {
    return { url: 'https://t.me/' + tgMatch[1] + (body ? '?text=' + body : ''), prefilled: !!body };
  }

  // Группа или канал Telegram (инвайт-ссылка t.me/+…, /joinchat/… или
  // приватная t.me/c/…). Текст туда не подставляется — Telegram
  // разрешает это только личным чатам и ботам.
  //
  // Через «Поделиться» (t.me/share/url) заказ доставить можно, но
  // Telegram на том экране отправляет сообщение сразу по выбору чата:
  // ни увидеть его, ни поправить перед отправкой нельзя. Для закупки
  // это не годится — заказ правят на ходу («пармезан не нужен, привезли
  // вчера»). Поэтому здесь остаётся обычный путь: открыть чат и
  // вставить из буфера, где текст виден в поле ввода и редактируется.
  if (/t(?:elegram)?\.me\/(\+|joinchat\/|c\/)/i.test(link)) {
    return { url: link, prefilled: false, needsPaste: true };
  }

  // Viber: ссылка вида viber://chat?number=... или страница с номером в query.
  // Подстановку текста Viber не поддерживает — здесь только переход.
  var viberNumberMatch = link.match(/[?&]number=(%2B\d+|\+?\d+)/i);
  if (/viber/i.test(link) && viberNumberMatch) {
    var viberNumber = decodeURIComponent(viberNumberMatch[1]);
    return { url: 'viber://chat?number=' + encodeURIComponent(viberNumber), prefilled: false };
  }

  return { url: link, prefilled: false };
}

/* Копирует отчёт текущего шага в буфер обмена. Сам переход в чат теперь
   выполняет БРАУЗЕР — не мы. Это принципиально: даже переход через
   элемент <a>, СОЗДАННЫЙ и "нажатый" кодом (element.click()), браузер
   помечает как несинтетический (не настоящий тап пальцем) и поэтому
   всё равно не выполняет прямую передачу управления приложению
   (Universal Link) — вместо этого сначала грузит саму веб-страницу
   (t.me/wa.me), а уже её собственный скрипт пытается открыть
   приложение через кастомную схему (tg://, whatsapp://, viber://) —
   и вот именно на этом шаге ОС каждый раз показывает диалог
   "Разрешить открытие приложения?", без возможности его запомнить.
   Единственный способ получить настоящую прямую передачу без диалога —
   чтобы переход инициировал НАСТОЯЩИЙ тап пользователя по НАСТОЯЩЕЙ
   ссылке <a href="...">, уже присутствующей в разметке (см.
   send-purchase-copy-btn в index.html и его href, который выставляется
   заранее в renderSendAllPurchaseStep). Поэтому здесь мы НЕ вызываем
   window.location / window.open — просто копируем текст и разблокируем
   кнопку "Далее"; переход по ссылке браузер делает сам, обрабатывая тот
   же самый клик, которым была нажата эта кнопка. */
/* ================================================================
   ОТПРАВКА ЗАКАЗА БОТОМ (только группы)
   ================================================================
   В личный чат Telegram текст подставляется прямо в поле ввода — там
   бот не нужен. А вот в группу подставить нельзя ни при каком виде
   ссылки: это проверено на живом устройстве и на публичной группе тоже.
   Поэтому для групп заказ отправляет бот — одним нажатием, не открывая
   Telegram вовсе.

   ТОКЕН НЕ ХРАНИТСЯ В ФАЙЛАХ САЙТА. Он лежит только в браузере того,
   кто рассылает закупку, — как GitHub-ключ разработчика. Положи мы его
   в site-config.json, он оказался бы виден любому, кто откроет сайт, и
   писать в вашу группу от имени бота смог бы кто угодно.
   ================================================================ */
const TG_BOT_TOKEN_KEY = 'r20_tg_bot_token';

/* Токен ищем сначала в настройках сайта, потом в браузере.
   Общий в настройках — чтобы не вводить его на каждом телефоне: закупку
   рассылают с разных устройств, и требовать ввода на каждом оказалось
   неудобно. Плата за это честная: site-config.json публичный, и тот,
   кто его откроет, сможет писать в группу от имени бота (читать
   переписку — нет). Локальное значение осталось и имеет приоритет: им
   можно переопределить общий токен на одном устройстве. */
function getTelegramBotToken() {
  var local = '';
  try { local = localStorage.getItem(TG_BOT_TOKEN_KEY) || ''; } catch (e) {}
  if (local) return local;
  return (siteConfig && siteConfig.telegramBotToken) || '';
}

/* Может ли этот человек сохранить токен для всех. Публикация настроек
   идёт через GitHub, значит нужен ключ — он есть у администратора и
   разработчика. У остальных токен ляжет только в их браузер. */
function canShareBotToken() {
  var cfg = getGithubConfig();
  return !!(cfg && cfg.owner && cfg.repo && cfg.token);
}

/* Куда бот отправит сообщение. Для группы с коротким именем адресом
   служит само имя (@routezakup). Для приватной группы имени нет —
   тогда нужен числовой идентификатор, его вписывают в карточке. */
function purchaseChatTarget(c) {
  if (!c) return '';
  if (c.chatId) return String(c.chatId).trim();
  var link = (c.link || '').trim();
  var m = link.match(/t(?:elegram)?\.me\/([a-zA-Z0-9_]{4,32})(?:[/?]|$)/i);
  if (m && !/t(?:elegram)?\.me\/(\+|joinchat\/|c\/)/i.test(link)) return '@' + m[1];
  return '';
}

/* Бот применим к любому телеграм-адресу, для которого мы знаем, куда
   писать. Отличить группу от личного чата по ссылке нельзя — t.me/имя
   выглядит одинаково у обоих, — поэтому решение оставляем человеку:
   кнопка «Открыть чат» никуда не делась и стоит рядом.
   WhatsApp и Viber сюда не попадают: там свои приложения, и текст в них
   подставляется своими средствами. */
function canSendViaBot(c) {
  if (!getTelegramBotToken()) return false;
  if (!purchaseChatTarget(c)) return false;
  var link = ((c && c.link) || '').trim();
  return /t(?:elegram)?\.me\//i.test(link) || !!(c && c.chatId);
}

/* Идентификатор чата для приватной группы. У неё нет короткого имени,
   поэтому бот адресует её числом вида -1004492131511. Число не секретное
   и хранится в шаблоне закупки рядом со ссылкой. */
async function setPurchaseChatId(cat) {
  cat = cat || currentPurchaseCategory;
  if (!can('purchase.template')) { denyToast('purchase.template'); return; }
  var c = purchaseCategoryById(cat);
  if (!c) return;

  var val = await showModal({
    title: '🆔 Идентификатор чата — ' + c.label,
    message: 'Нужен только приватным группам, у которых нет адреса вида t.me/имя. Узнать его можно так: добавьте бота в группу, напишите там любое сообщение и откройте в браузере api.telegram.org/bot<ТОКЕН>/getUpdates — там будет "chat":{"id":-100…}. Скопируйте число вместе с минусом.',
    withInput: true,
    inputValue: c.chatId || '',
    placeholder: '-1001234567890',
    okText: '💾 Сохранить'
  });
  if (val === null) return;

  c.chatId = (val || '').trim();
  stampEdit(c, 'указал идентификатор чата');
  savePurchaseData();
  schedulePurchaseSync();
  updatePurchaseTemplateControls();
  showToast(c.chatId ? '✅ Идентификатор сохранён' : '✅ Идентификатор убран');
}

async function setTelegramBotToken() {
  /* Достаточно доступа к закупке. Раньше требовалось право менять
     шаблон — то есть чтобы человек с ролью «Закупка» мог отправлять
     заказы ботом, ему пришлось бы открыть и правку норм. Это лишнее:
     токен не меняет ничего в данных сайта, он лежит только в браузере
     этого человека и позволяет ему нажать «отправить». */
  if (!hasPurchaseAccess()) { showToast('🔒 Настройка бота доступна тем, у кого открыта закупка'); return; }
  var current = getTelegramBotToken();
  var shared = canShareBotToken();
  var token = await showModal({
    title: '🤖 Токен бота для отправки в группы',
    message: shared
      ? 'Токен сохранится в настройках сайта и заработает на всех устройствах — вводить его на каждом телефоне не нужно.\n\nВажно: файл настроек открыт всем, кто знает адрес сайта. Тот, кто его прочтёт, сможет отправлять сообщения в вашу группу от имени бота (читать переписку — нет). Если это нежелательно, заведите отдельного бота только для заказов.\n\nОчистите поле, чтобы отключить отправку ботом.'
      : 'Токен сохранится только в этом браузере. Возьмите его у администратора.\n\nОчистите поле, чтобы отключить отправку ботом.',
    withInput: true,
    inputValue: current,
    placeholder: '1234567890:AA...',
    okText: '💾 Сохранить'
  });
  if (token === null) return;
  token = (token || '').trim();

  if (!token) {
    try { localStorage.removeItem(TG_BOT_TOKEN_KEY); } catch (e) {}
    if (shared && siteConfig.telegramBotToken) {
      siteConfig.telegramBotToken = '';
      saveSiteConfigLocal();
      await syncSiteConfigToGithub();
    }
    showToast('🤖 Отправка ботом отключена');
    updatePurchaseTemplateControls();
    return;
  }

  // Проверяем токен сразу: ошибиться в длинной строке легко, и лучше
  // узнать об этом здесь, чем посреди рассылки.
  showToast('⏳ Проверяю токен...');
  try {
    var res = await fetch('https://api.telegram.org/bot' + token + '/getMe');
    var data = await res.json();
    if (!data || !data.ok) {
      showToast('⚠️ Телеграм не принял токен: ' + ((data && data.description) || 'неизвестная ошибка'));
      return;
    }
    if (shared) {
      // Кладём в общие настройки — тогда бот заработает у всех сразу.
      // Локальную копию при этом чистим, иначе она перекрывала бы общий
      // токен и смена ключа не доходила бы до этого устройства.
      siteConfig.telegramBotToken = token;
      try { localStorage.removeItem(TG_BOT_TOKEN_KEY); } catch (e) {}
      saveSiteConfigLocal();
      var published = await syncSiteConfigToGithub();
      if (!published) {
        // Опубликовать не вышло — оставляем хотя бы на этом устройстве,
        // чтобы рассылка не встала.
        try { localStorage.setItem(TG_BOT_TOKEN_KEY, token); } catch (e) {}
        showToast('⚠️ Бот работает только на этом устройстве: настройки не опубликовались');
      } else {
        logActivity('подключил бота для отправки заказов', 'Настройки', '@' + (data.result && data.result.username));
      }
    } else {
      try { localStorage.setItem(TG_BOT_TOKEN_KEY, token); } catch (e) {}
    }
    showToast('✅ Бот подключён: @' + (data.result && data.result.username) + (shared ? ' — на всех устройствах' : ' — на этом устройстве'));
    updatePurchaseTemplateControls();
    renderPurchaseHomeList();
    // Если окно рассылки открыто — перерисовываем шаг, чтобы кнопка
    // отправки появилась сразу, без выхода и повторного запуска.
    if (sendAllPurchaseQueue.length && sendAllPurchaseIndex < sendAllPurchaseQueue.length) {
      renderSendAllPurchaseStep();
    }
  } catch (e) {
    showToast('⚠️ Не удалось связаться с Телеграм: ' + e.message);
  }
}

/* Что именно отправляем. Ровно то, что человек видит в окне: поле
   редактируемое, и правки в заказ вносят постоянно. Раньше бот
   пересобирал текст заново и отправлял «как посчитано», молча теряя
   всё, что подправили руками. */
function currentSendText(c) {
  var textEl = $('send-purchase-text');
  var shown = textEl ? textEl.value.trim() : '';
  return shown || buildPurchaseReportText(c.id);
}

/* Отправка заказа ботом. По решению «одним нажатием»: подтверждения
   нет, сообщение уходит сразу и мастер переходит к следующему. */
async function sendPurchaseViaBot(cat) {
  /* Кого именно отправляем. Раньше здесь при пустом аргументе брался
     currentPurchaseCategory — поставщик, ОТКРЫТЫЙ НА ЭКРАНЕ. Но мастер
     рассылки идёт по своей очереди и currentPurchaseCategory не меняет,
     поэтому всем пятнадцати поставщикам уходил один и тот же заказ —
     тот, чью карточку человек открывал последней.
     Поэтому пока мастер открыт, адресата берём строго из очереди. */
  var c = null;
  if (cat) {
    c = purchaseCategoryById(cat);
  } else if (sendAllPurchaseIndex < sendAllPurchaseQueue.length) {
    c = sendAllPurchaseQueue[sendAllPurchaseIndex];
  } else {
    c = purchaseCategoryById(currentPurchaseCategory);
  }
  if (!c) return;
  var token = getTelegramBotToken();
  var target = purchaseChatTarget(c);
  if (!token || !target) { showToast('⚠️ Бот не настроен для этого поставщика'); return; }

  var btn = $('send-purchase-bot-btn');
  if (btn) btn.disabled = true;
  showToast('⏳ Отправляю ботом...');

  try {
    var res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text: currentSendText(c) })
    });
    var data = await res.json();
    if (!data || !data.ok) {
      // Частые ответы: chat not found (бот не в группе или имя другое),
      // not enough rights (бот не админ). Показываем как есть — по
      // тексту ошибки понятно, что чинить.
      showToast('⚠️ Не отправлено: ' + ((data && data.description) || 'ошибка Телеграм'));
      if (btn) btn.disabled = false;
      return;
    }
    logActivity('отправил заказ поставщику', 'Закупка · ' + venueLabel(currentVenueId()), c.label + ' (ботом)');
    showToast('✅ Заказ отправлен в «' + c.label + '»');
    sendAllPurchaseNext(); // сразу к следующему — так и договаривались
  } catch (e) {
    showToast('⚠️ Не удалось связаться с Телеграм: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

function sendAllPurchaseOpenAndCopy(event) {
  var c = sendAllPurchaseQueue[sendAllPurchaseIndex];
  if (!c) return;
  var text = currentSendText(c);
  var resolved = resolvePurchaseAppLink(c.link, text);

  copyTextToClipboard(text, resolved.prefilled
    ? '✅ Текст подставлен в чат — остаётся отправить'
    : '📋 Заказ скопирован — вставьте его в чате (зажать поле ввода → «Вставить»)');

  if (!resolved.url) {
    if (event) event.preventDefault(); // ссылки нет — переходить некуда
  }
  // Если ссылка есть — ничего не отменяем: браузер сам перейдёт по
  // настоящему href этой ссылки, это и даёт переход без диалога.

  var nextBtn = $('send-purchase-next-btn');
  if (nextBtn) nextBtn.disabled = false;
}

function sendAllPurchaseNext() {
  sendAllPurchaseIndex++;
  saveSendAllPurchaseProgress();
  renderSendAllPurchaseStep();
}

function sendAllPurchaseSkip() {
  sendAllPurchaseIndex++;
  saveSendAllPurchaseProgress();
  renderSendAllPurchaseStep();
}

// Явное завершение закупки (кнопка "✅ Завершить закупку" на финальном шаге
// рассылки). В отличие от старого поведения (просто закрыть модалку и
// показать тост), теперь ещё и "закрываем" сами позиции у обработанных
// поставщиков/цехов — иначе кнопка "📤 Отправить всё поставщикам" на
// главной странице закупки так и продолжала бы её показывать (условие её
// показа — есть ли ещё что заказывать, см. renderPurchaseHomeList): для
// каждой позиции с заданной нормой считаем остаток равным норме (то, что
// нужно было докупить, купили — к заказу 0), а разовый дозаказ, который
// только что отправили поставщику, обнуляем. Названия/нормы/ед. измерения
// и сама ссылка поставщика не трогаем — это шаблон, он остаётся для
// следующей закупки. Как и остальные поля "Остаток"/"Дозаказ", это
// затрагивает только этот браузер и не уходит в GitHub.
function finishSendAllPurchase() {
  var processedCount = sendAllPurchaseQueue.length;
  sendAllPurchaseQueue.forEach(function(c) {
    purchaseRowsFor(c.id).forEach(function(r) {
      if (r.norm !== undefined && r.norm !== null && String(r.norm).trim() !== '') r.residual = r.norm;
      r.reorder = '';
    });
  });
  savePurchaseData();
  closeSendAllPurchaseModal();
  showToast('✅ Закупка завершена — обработано поставщиков/цехов: ' + processedCount);
  sendAllPurchaseQueue = [];
  sendAllPurchaseIndex = 0;
  clearSendAllPurchaseProgress();
  renderPurchaseTab();
}

/* "Отмена" — это осознанный отказ от рассылки, поэтому стираем и
   сохранённый прогресс (в отличие от случайного закрытия вкладки, после
   которого прогресс должен остаться и предложить продолжить). */
function cancelSendAllPurchase() {
  closeSendAllPurchaseModal();
  sendAllPurchaseQueue = [];
  sendAllPurchaseIndex = 0;
  clearSendAllPurchaseProgress();
  renderPurchaseHomeList();
  showToast('Рассылка отменена');
}

function closeSendAllPurchaseModal() {
  var overlay = $('send-purchase-overlay');
  if (overlay) overlay.classList.remove('show');
}

/* ================================================================
   UTILITY
   ================================================================ */
function esc(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// For use in HTML attribute values (like src="...")
function escAttr(str) {
  if (str === undefined || str === null) str = '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Плавающая компактная кнопка "Назад" — ОДНА на всё приложение, общая для
   любого длинного экрана с обычной кнопкой "← Назад" (класс
   .floating-back-anchor: сейчас это экран рецепта и экран цеха/поставщика
   в "Закупке" — при добавлении новых экранов достаточно повесить этот
   класс на их кнопку "Назад", отдельный код не нужен).

   Логика: из всех .floating-back-anchor в любой момент реально виден
   (offsetParent !== null) максимум один — тот, что относится к сейчас
   открытому экрану (остальные скрыты через display:none у неактивной
   вкладки/подэкрана). Как только ЕГО кнопка прокручена за пределы экрана,
   показываем плавающую копию и копируем в неё то же действие (onclick) —
   так гостю не нужно прокручивать длинный экран наверх, чтобы вернуться
   назад. Срабатывает и на скролл, и на переключение вкладок/подэкранов
   (через IntersectionObserver — он видит изменения display у элементов,
   а не только скролл). */
function initFloatingBackButton() {
  var anchors = document.querySelectorAll('.floating-back-anchor');
  var floatingBtn = $('detail-back-floating');
  if (!anchors.length || !floatingBtn || typeof IntersectionObserver === 'undefined') return;

  function refresh() {
    var visibleAnchor = null;
    for (var i = 0; i < anchors.length; i++) {
      if (anchors[i].offsetParent !== null) { visibleAnchor = anchors[i]; break; }
    }
    if (!visibleAnchor) { floatingBtn.classList.remove('show'); return; }
    var rect = visibleAnchor.getBoundingClientRect();
    var scrolledAway = rect.bottom < 0; // ушла вверх за пределы экрана при прокрутке вниз
    if (scrolledAway) {
      var action = visibleAnchor.getAttribute('onclick');
      if (action) floatingBtn.setAttribute('onclick', action);
      floatingBtn.classList.add('show');
    } else {
      floatingBtn.classList.remove('show');
    }
  }

  var observer = new IntersectionObserver(refresh, { threshold: 0 });
  anchors.forEach(function(a) { observer.observe(a); });
  window.refreshFloatingBackButton = refresh; // на случай, если понадобится дёрнуть вручную из других функций

  // Подстраховка: переключение вкладок само по себе не всегда скроллит
  // страницу, но может сразу же открыть уже прокрученный вниз экран —
  // на такой случай проверяем ещё и по скроллу, и сразу после клика по
  // вкладке.
  window.addEventListener('scroll', refresh, { passive: true });
  document.querySelectorAll('.nav-tab').forEach(function(t) {
    t.addEventListener('click', function() { requestAnimationFrame(refresh); });
  });
}

/* ================================================================
   INIT — all event listeners bound after DOM is ready
   ================================================================ */
document.addEventListener('DOMContentLoaded', function() {
  initApp();
  initFloatingBackButton();
  initStickySearchOffset();
  initSearchScrollJumpGuard();
});

// Прописывает реальную высоту липкой панели вкладок (.nav-tabs) в
// CSS-переменную --nav-h, чтобы поисковые строки (.search-wrap, см.
// styles.css) могли прилипать сразу под ней без наложения — высота
// панели зависит от размера шрифта/экрана устройства, поэтому лучше
// измерить её реально, а не подбирать одно число вручную. Пересчитываем
// и при повороте экрана/изменении размера окна.
function applyStickySearchOffset() {
  var nav = document.querySelector('.nav-tabs');
  if (!nav) return;
  var h = nav.offsetHeight;
  // Пока стоит замок доступа, панель вкладок скрыта и её высота равна 0 —
  // такое значение записывать нельзя, иначе поисковая строка «прилипнет»
  // к самому верху и уедет под панель. Пересчитаем после unlockGate().
  if (!h) return;
  document.documentElement.style.setProperty('--nav-h', h + 'px');
}

function initStickySearchOffset() {
  applyStickySearchOffset();
  window.addEventListener('resize', applyStickySearchOffset);
  window.addEventListener('orientationchange', applyStickySearchOffset);
}

/* Снимает замок доступа: убирает заслонку «Загрузка…» и класс
   gate-locked с <html> (см. встроенный стиль в <head> index.html),
   после чего содержимое сайта впервые становится видимым. Вызывать
   только тогда, когда все проверки доступа реально пройдены. */
function unlockGate() {
  var gateOverlay = $('access-gate-overlay');
  if (gateOverlay) gateOverlay.remove();
  document.documentElement.classList.remove('gate-locked');
  applyStickySearchOffset(); // теперь панель вкладок видна — её высоту можно измерить
}

/* Защита от "прыжка" страницы в начало при вводе текста в поле поиска
   на телефоне (см. .search-wrap в index.html: главная "Закупка", общий
   список рецептов, поиск позиций внутри цеха/поставщика). Проблема
   воспроизводится и в Safari, и в Chrome на мобильных — то есть дело не
   в конкретном браузере, а в том, что при открытой экранной клавиатуре
   мобильный браузер сам "подскраливает" видимую область под сфокусированное
   поле и иногда промахивается в самый верх страницы (особенно когда список
   результатов под полем меняет высоту на каждое нажатие клавиши). Важно:
   на iOS такой "прыжок" далеко не всегда сопровождается обычным событием
   scroll на window — там пролистывается сама видимая область экрана
   (visualViewport), а не документ в привычном смысле, поэтому слушать
   scroll недостаточно. Вместо этого проверяем реальное положение самого
   поля на экране (getBoundingClientRect) сразу после каждого нажатия
   клавиши — это универсальный признак "уехало или нет", не зависящий от
   того, через какой именно внутренний механизм браузер это сделал — и
   если поле заметно "уехало" от того места, где было, тут же силой
   возвращаем его в кадр через scrollIntoView. */
function initSearchScrollJumpGuard() {
  var GUARDED_IDS = ['purchase-home-search', 'purchase-search-positions'];
  GUARDED_IDS.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function() {
      var before = el.getBoundingClientRect().top;
      // Два кадра подряд — на некоторых устройствах браузер выполняет
      // свою (порой ошибочную) подстройку скролла не мгновенно, а только
      // после того, как отрисовка от текущего нажатия клавиши уляжется.
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          var after = el.getBoundingClientRect().top;
          // Пока идёт печать, поле не должно заметно смещаться от того
          // места, где было до нажатия клавиши. Скачок больше высоты
          // панели вкладок означает, что страницу откатило к началу и
          // поле "уехало" вниз, в своё обычное (не прилипшее) положение.
          if (Math.abs(after - before) > 80) {
            el.scrollIntoView({ block: 'start', behavior: 'auto' });
          }
        });
      });
    });
  });
}

async function initApp() {
  await verifyStoredAdminSession(); // снимает флаг админа, если за ним нет рабочего GitHub-ключа — ДО любых проверок isAdmin()

  loadParticipantsLocal(); // сначала то, что уже знаем локально (на случай отсутствия сети)
  loadSiteConfigLocal();
  renderSectionNavTabs(); // сразу из локального кэша, не дожидаясь сети — см. syncSiteConfigFromGithub ниже за свежими данными
  renderCategoryChipRows(); // чипы категорий и список «Тип» в форме собираются из настроек, а не зашиты в разметку

  // Отмечаем "я тут" максимально рано — до какой-либо проверки одобрения
  // или блокировки, чтобы в списке "Онлайн" было видно вообще всех, кто
  // хотя бы открыл сайт, а не только уже одобренных участников.
  initFirebasePresence();

  var configPromise = syncSiteConfigFromGithub();

  // Если это устройство уже когда-то заблокировали — не тратим его время на
  // повторный ввод имени и отправку в Telegram, сразу показываем отказ.
  if (!isAdmin()) {
    await syncParticipantsFromGithub();
    var already = getMyParticipantRecord();
    if (already && already.blocked) { showBlockedScreen(); return; }
  }

  await configPromise; // нужен ДО приглашения ввести имя — от него зависит, обязателен ли шаг с Telegram
  await ensureParticipantName(); // держит экран "Загрузка…" поверх контента, пока гость не пройдёт этот шаг
  sendPresenceUpdate(); // теперь известно имя гостя — обновляем запись "Онлайн", чтобы оно там тоже появилось

  if (!isAdmin()) {
    var status = await checkParticipantStatus(); // ещё раз, свежо — вдруг администратор уже успел одобрить, пока шёл диалог выше
    if (status === 'blocked') { showBlockedScreen(); return; }
    if (status === 'pending') { showPendingScreen(); return; }
  }

  unlockGate();

  showDeviceCodeInFooter();
  startAccessPoll(); // с этого момента доступ переспрашивается каждые 15 секунд

  applyAdminUI();
  loadRecipes();
  loadActivityLocal();
  loadCustomSitePhotos();
  loadPurchaseData();
  syncPurchaseFromGithub().then(function() { if (currentTab === 'purchase') renderPurchaseTab(); });

  var hasDeepLink = /^#recipe=/.test(location.hash);

  // Разделы и их роли: переносим старые данные и раздаём роль главного
  // раздела (разово, у разработчика — см. migrateToSections).
  renderSectionNavTabs();

  if (hasDeepLink) {
    showDetailLoading(); // сразу показываем "Загрузка рецепта...", без мелькания общего списка
  } else {
    goToDefaultSection();
    refreshAllSectionLists();
  }

  openRecipeFromHash(false); // если рецепт уже есть в локальном кэше — откроется сразу, минуя загрузку

  syncFromGithub().then(function() {
    openRecipeFromHash(true); // финальная попытка на свежих данных с GitHub
    if (hasDeepLink && currentTab !== 'detail') {
      // Ссылка была, но рецепт так и не нашёлся — показываем обычный список вместо "вечной загрузки"
      goToDefaultSection();
    }
    refreshAllSectionLists();
    migrateToSections();
  });

  // Tab click handlers
  document.querySelectorAll('.nav-tab').forEach(function(tab) {
    tab.addEventListener('click', function() { switchTab(tab.dataset.tab); });
  });
}

function showDetailLoading() {
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
  var detailTab = $('tab-detail');
  if (detailTab) detailTab.classList.add('active');
  window.scrollTo(0, 0);
  var body = $('detail-body');
  if (body) body.innerHTML =
    '<div class="skeleton skeleton-photo"></div>' +
    '<div class="skeleton skeleton-title"></div>' +
    '<div class="skeleton skeleton-badges">' +
      '<div class="skeleton skeleton-chip"></div>' +
      '<div class="skeleton skeleton-chip"></div>' +
      '<div class="skeleton skeleton-chip"></div>' +
    '</div>' +
    '<div class="skeleton skeleton-line" style="width:40%"></div>' +
    '<div class="skeleton skeleton-line"></div>' +
    '<div class="skeleton skeleton-line"></div>' +
    '<div class="skeleton skeleton-line" style="width:70%"></div>';
  currentTab = 'detail';
}
