(() => {
  'use strict';

  const TASKS_KEY = 'myday.tasks.v1';
  const TEMPLATES_KEY = 'myday.templates.v1';
  const TEMPLATE_SORT_KEY = 'myday.templateSort.v1';
  const LAST_BACKUP_KEY = 'myday.lastBackup.v1';
  const BACKUP_SNOOZE_KEY = 'myday.backupSnooze.v1';
  const BACKUP_REMIND_DAYS = 7;
  const MAX_TEMPLATES = 20;
  const THEME_KEY = 'myday.theme.v1';
  const SORT_KEY = 'myday.sort.v1';
  const HISTORY_FILTER_KEY = 'myday.historyFilter.v1';
  const SORT_MODES = ['date', 'priority', 'newest'];
  const HISTORY_FILTERS = ['all', 'completed', 'skipped'];
  const CATEGORIES = {
    work: 'Работа', personal: 'Лични', shopping: 'Пазаруване', other: 'Други'
  };
  const REPEATS = { none: '', daily: 'Всеки ден', weekly: 'Всяка седмица', monthly: 'Всеки месец' };
  const VIEWS = {
    today: ['Твоят фокус', 'Задачи за днес'],
    upcoming: ['Планирай спокойно', 'Предстоящи задачи'],
    all: ['Всичко на едно място', 'Всички активни задачи'],
    done: ['История на задачите', 'Завършени и пропуснати'],
    calendar: ['Избран ден', 'Задачи за деня']
  };
  const el = (id) => document.getElementById(id);
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const MAX_SUBTASKS = 30;
  // Formatting dates once per render, rather than constructing a formatter for each card,
  // keeps longer task lists responsive on modest Android devices.
  const shortDateFormatter = new Intl.DateTimeFormat('bg-BG', { day: 'numeric', month: 'short' });
  const searchIndex = new WeakMap(); // Derived data only; never written to localStorage.
  const checklistActions = new Set(['subtask', 'subtasks-complete', 'subtasks-reset', 'pending-only', 'expand']);
  let checklistFocus = null;
  let searchRenderTimer = null;
  const isFinished = (task) => task.done || task.skipped;
  // Never replace an unreadable localStorage value with an empty task list.
  let storageProblem = null; // 'damaged' | 'unavailable' | null
  let damagedRaw = null;
  let lastSavedRaw = null;
  let editorOutdated = false;
  let tasks = readTasks();
  let templatesRaw = null;
  let templatesProblem = false;
  let templates = readTemplates();
  let templateSort = 'popular';
  let pendingTemplateId = null;
  let sortMode = 'date';
  let historyFilter = 'all';
  let view = 'today';
  let editingId = null;
  let duplicating = false;
  let editingTemplateId = null;
  let templateEditorOriginalRecord = '';
  let templateEditorInitialState = '';
  let editorInitialState = '';
  let movingId = null;
  let selectedDate = localDate();
  let monthCursor = selectedDate.slice(0, 7);
  let toastTimer = null;
  const expandedSubtasks = new Set();
  const pendingOnlySubtasks = new Set();
  // Unsaved text in the inline checklist field is kept only in memory.
  const inlineSubtaskDrafts = new Map();
  // 1.17: Editing a checklist item stays local until explicitly saved.
  // Keep the draft across card re-renders (e.g. checking a different item).
  let inlineSubtaskEdit = null;

  function localDate(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function isValidDate(value) {
    if (value === '') return true;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00`);
    return !Number.isNaN(date.getTime()) && localDate(date) === value;
  }
  function safeString(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }
  function dayOfMonth(date) { return Number(date.slice(8, 10)); }
  // Calendar arithmetic uses UTC date parts so daylight-saving changes do not shift dates.
  function utcDays(value) {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
  }
  function dateFromUtcDays(days) { return new Date(days * 86400000).toISOString().slice(0, 10); }
  function monthlyOccurrence(year, monthIndex, targetDay) {
    const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, monthIndex, Math.min(targetDay, daysInMonth))).toISOString().slice(0, 10);
  }
  function nextRepeatDate(task, today = localDate()) {
    // Never create backlogged missed occurrences. Always advance beyond both
    // the original scheduled date and the current day.
    const baseline = task.date > today ? task.date : today;
    if (task.repeat === 'daily' || task.repeat === 'weekly') {
      const unit = task.repeat === 'daily' ? 1 : 7;
      const diff = utcDays(baseline) - utcDays(task.date);
      return dateFromUtcDays(utcDays(task.date) + (Math.floor(diff / unit) + 1) * unit);
    }
    if (task.repeat === 'monthly') {
      const [year, month] = baseline.split('-').map(Number);
      const [startYear, startMonth] = task.date.split('-').map(Number);
      const anchorDay = task.repeatDay || dayOfMonth(task.date);
      const firstMonthIndex = Math.max(year * 12 + month - 1, startYear * 12 + startMonth);
      let monthIndex = firstMonthIndex;
      let candidate;
      do {
        candidate = monthlyOccurrence(Math.floor(monthIndex / 12), monthIndex % 12, anchorDay);
        monthIndex++;
      } while (candidate <= baseline);
      return candidate;
    }
    return '';
  }
  function normalizeSubtasks(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const normalized = [];
    for (const item of value.slice(0, MAX_SUBTASKS)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const text = safeString(item.text, 100).trim();
      if (!text) continue;
      let id = safeString(item.id, 100) || makeId();
      if (seen.has(id)) id = makeId();
      seen.add(id);
      normalized.push({ id, text, done: item.done === true });
    }
    return normalized;
  }
  function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const title = safeString(raw.title, 160).trim();
    const date = safeString(raw.date, 10);
    if (!title || !isValidDate(date)) return null;
    const repeat = date && Object.hasOwn(REPEATS, raw.repeat) ? raw.repeat : 'none';
    const repeatDay = repeat === 'monthly'
      ? (Number.isInteger(raw.repeatDay) && raw.repeatDay >= 1 && raw.repeatDay <= 31 ? raw.repeatDay : dayOfMonth(date))
      : null;
    return {
      id: safeString(raw.id, 100) || makeId(),
      title,
      note: safeString(raw.note, 1500),
      subtasks: normalizeSubtasks(raw.subtasks),
      date,
      category: Object.hasOwn(CATEGORIES, raw.category) ? raw.category : 'other',
      priority: raw.priority === 'high' ? 'high' : 'normal',
      pinned: raw.pinned === true,
      repeat,
      repeatDay,
      previousId: safeString(raw.previousId, 100) || null,
      autoGenerated: raw.autoGenerated === true,
      deletedAt: safeString(raw.deletedAt, 30) || null,
      done: raw.done === true,
      // Skipping is not the same as completing a task. Old backups omit these fields.
      skipped: raw.done !== true && raw.skipped === true,
      skippedAt: raw.done !== true && raw.skipped === true ? (safeString(raw.skippedAt, 30) || new Date().toISOString()) : null,
      createdAt: safeString(raw.createdAt, 30) || new Date().toISOString(),
      completedAt: raw.done === true ? (safeString(raw.completedAt, 30) || new Date().toISOString()) : null
    };
  }
  function readTasks() {
    let raw;
    try { raw = localStorage.getItem(TASKS_KEY); }
    catch {
      storageProblem = 'unavailable';
      lastSavedRaw = null;
      return [];
    }
    lastSavedRaw = raw;
    if (raw === null) { storageProblem = null; damagedRaw = null; return []; }
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error('Expected a task array');
      const normalized = data.map(normalizeTask);
      if (normalized.some((item) => !item)) throw new Error('Invalid task record');
      const ids = normalized.map((item) => item.id);
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate task IDs');
      storageProblem = null;
      damagedRaw = null;
      return normalized;
    } catch {
      storageProblem = 'damaged';
      damagedRaw = raw;
      return [];
    }
  }
  function saveTasks(next) {
    if (storageProblem) {
      showToast('Записът е блокиран за защита на данните. Виж предупреждението горе.');
      return false;
    }
    try {
      // A second browser tab may have newer data. Do not silently overwrite it.
      if (localStorage.getItem(TASKS_KEY) !== lastSavedRaw) {
        tasks = readTasks();
        render();
        showToast('Задачите са променени в друг прозорец. Провери списъка и опитай отново.');
        return false;
      }
      const serialized = JSON.stringify(next);
      localStorage.setItem(TASKS_KEY, serialized);
      lastSavedRaw = serialized;
      tasks = next;
      render();
      return true;
    } catch {
      showToast('Неуспешен запис. Провери свободното място и направи backup.');
      return false;
    }
  }
  // Templates are intentionally separate from tasks. They never appear as unfinished work.
  // A damaged template record is kept untouched instead of being silently replaced by [].
  function normalizeTemplate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.id !== 'string' || !raw.id.trim() ||
        typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 160 ||
        !Array.isArray(raw.subtasks) || raw.subtasks.length > MAX_SUBTASKS ||
        raw.subtasks.some((text) => typeof text !== 'string' || !text.trim() || text.length > 100)) return null;
    return {
      id: raw.id.slice(0, 100), title: raw.title.trim(),
      note: safeString(raw.note, 1500),
      category: Object.hasOwn(CATEGORIES, raw.category) ? raw.category : 'other',
      priority: raw.priority === 'high' ? 'high' : 'normal',
      subtasks: raw.subtasks.map((text) => text.trim()),
      // Usage is optional: existing v1.8 templates start at zero.
      useCount: Number.isSafeInteger(raw.useCount) && raw.useCount >= 0 ? Math.min(raw.useCount, 1000000) : 0
    };
  }
  function validateTemplates(input) {
    if (!Array.isArray(input) || input.length > MAX_TEMPLATES) throw new Error('Невалиден списък с шаблони.');
    const normalized = input.map(normalizeTemplate);
    if (normalized.some((item) => !item)) throw new Error('Невалиден шаблон.');
    if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error('Повтарящ се шаблон.');
    return normalized;
  }
  function readTemplates() {
    try {
      const raw = localStorage.getItem(TEMPLATES_KEY);
      templatesRaw = raw;
      const parsed = raw === null ? [] : JSON.parse(raw);
      const result = validateTemplates(parsed);
      templatesProblem = false;
      return result;
    } catch {
      templatesProblem = true;
      return [];
    }
  }
  function saveTemplates(next) {
    if (templatesProblem) {
      showToast('Шаблоните не могат да се прочетат. Данните им са запазени; не ги презаписвам.');
      return false;
    }
    try {
      if (localStorage.getItem(TEMPLATES_KEY) !== templatesRaw) {
        templates = readTemplates();
        renderTemplates();
        showToast('Шаблоните са променени в друг прозорец. Опитай отново.');
        return false;
      }
      const valid = validateTemplates(next);
      const serialized = JSON.stringify(valid);
      localStorage.setItem(TEMPLATES_KEY, serialized);
      templatesRaw = serialized;
      templates = valid;
      renderTemplates();
      return true;
    } catch {
      showToast('Не успях да запазя шаблоните. Провери свободното място.');
      return false;
    }
  }
  function templateFromTask(source) {
    return { id: makeId(), title: source.title, note: source.note,
      category: source.category, priority: source.priority,
      subtasks: source.subtasks.map((part) => part.text), useCount: 0 };
  }
  function saveTaskAsTemplate(source) {
    if (!source || source.deletedAt) return;
    if (templatesProblem) { showToast('Проблем при прочитане на шаблоните. Нищо не е изтрито.'); return; }
    if (templates.length >= MAX_TEMPLATES) { showToast(`Можеш да имаш до ${MAX_TEMPLATES} шаблона.`); return; }
    const candidate = templateFromTask(source);
    if (templates.some((item) => item.title === candidate.title && item.note === candidate.note &&
        item.category === candidate.category && JSON.stringify(item.subtasks) === JSON.stringify(candidate.subtasks))) {
      showToast('Вече имаш шаблон с този списък.'); return;
    }
    if (saveTemplates([candidate, ...templates])) showToast('Шаблонът е запазен. Отвори „Моите шаблони“, за да го използваш.');
  }
  function renderTemplates() {
    el('templatesCount').textContent = templates.length;
    const list = el('templatesList');
    if (templatesProblem) {
      list.innerHTML = '<div class="templates-empty">Записът на шаблоните не може да бъде прочетен. Няма да го презапиша. Запази данните от браузъра и потърси помощ преди промяна.</div>';
      return;
    }
    if (!templates.length) {
      list.innerHTML = '<div class="templates-empty">Все още нямаш шаблони. Намери задача или списък за пазаруване и натисни „Запази шаблон“ под него.</div>';
      return;
    }
    // Popular templates rise after a *saved* task. Equal counts keep original order.
    const visible = templates.map((item, index) => ({item, index}));
    if (templateSort === 'popular') visible.sort((a, b) => b.item.useCount - a.item.useCount || a.index - b.index);
    list.innerHTML = visible.map(({item}) => `<div class="template-item">
      <strong>${escapeHtml(item.title)}</strong>
      <small>${escapeHtml(CATEGORIES[item.category])} · ${item.subtasks.length} подзадачи · ${item.useCount} ${item.useCount === 1 ? 'използване' : 'използвания'}</small>
      <div class="template-item-actions">
        <button type="button" class="template-use" data-template-action="use" data-template-id="${escapeHtml(item.id)}">Използвай</button>
        <button type="button" class="template-edit" data-template-action="edit" data-template-id="${escapeHtml(item.id)}">Редактирай</button>
        <button type="button" class="template-remove" data-template-action="remove" data-template-id="${escapeHtml(item.id)}">Изтрий</button>
      </div></div>`).join('');
  }
  function useTemplate(id) {
    const item = templates.find((t) => t.id === id);
    if (!item) return;
    el('templatesDialog').close();
    openEditor();
    pendingTemplateId = item.id;
    el('dialogTitle').textContent = 'Задача от шаблон';
    el('saveButton').textContent = 'Създай задача';
    el('duplicateHint').hidden = false;
    el('taskTitle').value = item.title;
    el('taskNote').value = item.note;
    el('taskCategory').value = item.category;
    el('taskPriority').value = item.priority;
    el('taskRepeat').value = 'none';
    // New IDs and unchecked subtasks; no link to the original task or template.
    renderSubtaskEditor(item.subtasks.map((text) => ({ id: makeId(), text, done: false })));
    editorInitialState = captureEditorState();
    updateDraftStatus();
  }
  function templateEditFormState() {
    return JSON.stringify({
      title: el('templateEditName').value,
      note: el('templateEditNote').value,
      category: el('templateEditCategory').value,
      priority: el('templateEditPriority').value,
      subtasks: el('templateEditItems').value.replace(/\r\n/g, '\n')
    });
  }
  function updateTemplateDraftStatus() {
    const dirty = editingTemplateId !== null && templateEditFormState() !== templateEditorInitialState;
    const status = el('templateEditDraftStatus');
    status.textContent = dirty ? 'Има незапазени промени' : 'Няма незапазени промени';
    status.classList.toggle('dirty', dirty);
  }
  function openTemplateEditor(id) {
    const item = templates.find((t) => t.id === id);
    if (!item || templatesProblem) return;
    editingTemplateId = id;
    templateEditorOriginalRecord = JSON.stringify(item);
    el('templateEditName').value = item.title;
    el('templateEditNote').value = item.note;
    el('templateEditCategory').value = item.category;
    el('templateEditPriority').value = item.priority;
    el('templateEditItems').value = item.subtasks.join('\n');
    templateEditorInitialState = templateEditFormState();
    updateTemplateDraftStatus();
    el('templatesDialog').close();
    el('templateEditDialog').showModal();
    el('templateEditName').focus();
  }
  function finishTemplateEditor() {
    el('templateEditDialog').close();
    editingTemplateId = null;
    renderTemplates();
    el('templatesDialog').showModal();
  }
  function closeTemplateEditor() {
    if (editingTemplateId !== null && templateEditFormState() !== templateEditorInitialState &&
        !confirm('Имаш незапазени промени в шаблона. Да ги изхвърля ли?')) return;
    finishTemplateEditor();
  }
  function saveEditedTemplate(event) {
    event.preventDefault();
    if (!editingTemplateId || templatesProblem) return;
    const original = templates.find((t) => t.id === editingTemplateId);
    if (!original || JSON.stringify(original) !== templateEditorOriginalRecord) {
      showToast('Шаблонът е променен в друг прозорец. Затвори редактора и го отвори отново.');
      return;
    }
    const title = el('templateEditName').value.trim();
    const note = el('templateEditNote').value;
    const rows = el('templateEditItems').value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    if (!title || title.length > 160) { showToast('Въведи име до 160 символа.'); return; }
    if (rows.length > MAX_SUBTASKS || rows.some((v) => v.length > 100)) {
      showToast('Може да имаш до 30 подзадачи, до 100 символа на ред.');
      return;
    }
    const edited = {
      ...original, title, note,
      category: el('templateEditCategory').value,
      priority: el('templateEditPriority').value,
      subtasks: rows
    };
    // Keep the original ID so backups and existing templates remain compatible.
    if (!saveTemplates(templates.map((item) => item.id === original.id ? edited : item))) return;
    finishTemplateEditor();
    showToast('Шаблонът е обновен. Съществуващите задачи не са променени.');
  }

  function removeTemplate(id) {
    const item = templates.find((t) => t.id === id);
    if (!item || !confirm(`Изтрий шаблона „${item.title}“? Самите задачи няма да се изтрият.`)) return;
    if (saveTemplates(templates.filter((t) => t.id !== id))) showToast('Шаблонът е изтрит. Задачите остават.');
  }

  function makeId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  function escapeHtml(input) {
    return String(input).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }
  function searchText(task) {
    let text = searchIndex.get(task);
    if (text === undefined) {
      text = (task.title + ' ' + task.note + ' ' + task.subtasks.map((part) => part.text).join(' '))
        .toLocaleLowerCase('bg-BG');
      searchIndex.set(task, text);
    }
    return text;
  }

  function rememberChecklistPosition(button) {
    const action = button.dataset.action;
    if (!checklistActions.has(action)) return;
    const id = button.dataset.id;
    const parts = [...el('taskList').querySelectorAll('button[data-action="subtask"]')]
      .filter((part) => part.dataset.id === id);
    checklistFocus = {
      action, id, subId: button.dataset.subId || '',
      index: parts.indexOf(button), top: button.getBoundingClientRect().top
    };
  }

  function restoreChecklistPosition() {
    const saved = checklistFocus;
    checklistFocus = null;
    if (!saved) return;
    const controls = [...el('taskList').querySelectorAll('button[data-action]')]
      .filter((button) => button.dataset.id === saved.id);
    const exact = controls.find((button) => button.dataset.action === saved.action &&
      (!saved.subId || button.dataset.subId === saved.subId));
    const remaining = controls.filter((button) => button.dataset.action === 'subtask');
    // A checked item may disappear under 'Само оставащите'. Focus its next
    // item instead, or the checklist toggle if there are no visible items.
    const fallback = remaining[Math.max(0, Math.min(saved.index, remaining.length - 1))]
      || controls.find((button) => button.dataset.action === 'expand');
    const target = exact || fallback;
    if (!target) return;
    target.focus({ preventScroll: true });
    const delta = target.getBoundingClientRect().top - saved.top;
    if (Math.abs(delta) > 2) window.scrollBy(0, delta);
  }

  function scheduleSearchRender() {
    if (searchRenderTimer !== null) clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
      searchRenderTimer = null;
      renderList();
    }, 120);
  }

  function prettyDate(value) {
    if (!value) return 'Без дата';
    const today = localDate();
    if (value === today) return 'Днес';
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (value === localDate(tomorrow)) return 'Утре';
    return shortDateFormatter.format(new Date(`${value}T12:00:00`));
  }
  function greeting() {
    const hour = new Date().getHours();
    return hour < 11 ? 'Добро утро' : hour < 18 ? 'Добър ден' : 'Добър вечер';
  }
  function showToast(message, action = null) {
    const toast = el('toast');
    // Text nodes prevent a task title from being interpreted as HTML.
    toast.replaceChildren(document.createTextNode(message));
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        clearTimeout(toastTimer);
        toast.classList.remove('show');
        action.run();
      }, { once: true });
      toast.append(button);
    }
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), action ? 8000 : 3100);
  }

  function renderCalendar() {
    const open = view === 'calendar';
    document.body.classList.toggle('calendar-open', open);
    el('calendarPanel').hidden = !open;
    el('calendarToggle').classList.toggle('active', open);
    el('calendarToggle').setAttribute('aria-pressed', String(open));
    el('calendarToggle').setAttribute('aria-expanded', String(open));
    if (!open) return;
    const [year, month] = monthCursor.split('-').map(Number);
    el('calendarMonth').textContent = new Intl.DateTimeFormat('bg-BG', {
      month: 'long', year: 'numeric'
    }).format(new Date(year, month - 1, 1, 12));
    const start = (new Date(year, month - 1, 1, 12).getDay() + 6) % 7;
    const length = new Date(year, month, 0, 12).getDate();
    const cells = Math.ceil((start + length) / 7) * 7;
    const planned = new Set(tasks.filter((task) => !task.deletedAt && !isFinished(task) && task.date).map((task) => task.date));
    const today = localDate();
    const formatter = new Intl.DateTimeFormat('bg-BG', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    const html = [];
    for (let index = 0; index < cells; index++) {
      const day = index - start + 1;
      if (day < 1 || day > length) {
        html.push('<span class="calendar-placeholder" aria-hidden="true"></span>');
        continue;
      }
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isSelected = date === selectedDate;
      const isToday = date === today;
      const hasTasks = planned.has(date);
      const human = formatter.format(new Date(year, month - 1, day, 12));
      html.push(`<button type="button" class="calendar-day${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}${hasTasks ? ' has-tasks' : ''}" data-calendar-date="${date}" aria-pressed="${isSelected}" aria-label="${human}${hasTasks ? ', има задачи' : ''}${isToday ? ', днес' : ''}"><span>${day}</span>${hasTasks ? '<i aria-hidden="true"></i>' : ''}</button>`);
    }
    el('calendarGrid').innerHTML = html.join('');
  }
  function shiftCalendarMonth(delta) {
    const [year, month] = monthCursor.split('-').map(Number);
    const next = new Date(year, month - 1 + delta, 1, 12);
    monthCursor = localDate(next).slice(0, 7);
    renderCalendar();
  }
  function selectCalendarDate(date) {
    if (!isValidDate(date) || !date) return;
    selectedDate = date;
    monthCursor = date.slice(0, 7);
    view = 'calendar';
    render();
  }
  function renderHeader() {
    const today = localDate();
    const currentTasks = tasks.filter((task) => !task.deletedAt);
    const active = currentTasks.filter((task) => !isFinished(task));
    const todayOpen = active.filter((task) => task.date && task.date <= today);
    const upcoming = active.filter((task) => task.date > today);
    // Use the phone's local date, not UTC, when calculating today's achievements.
    const completedLocallyToday = currentTasks.filter((task) => task.done && task.completedAt && localDate(new Date(task.completedAt)) === today);
    const count = todayOpen.length + completedLocallyToday.length;
    const pct = count ? Math.round(completedLocallyToday.length / count * 100) : 0;
    const dueToday = active.filter((task) => task.date === today).length;
    const overdue = active.filter((task) => task.date && task.date < today).length;
    const undated = active.filter((task) => !task.date).length;

    el('progressDue').textContent = `За днес: ${dueToday}`;
    el('progressOverdue').textContent = `Просрочени: ${overdue}`;
    el('progressOverdue').classList.toggle('attention', overdue > 0);
    el('progressUndated').textContent = `Без дата: ${undated}`;

    el('countToday').textContent = todayOpen.length;
    el('countUpcoming').textContent = upcoming.length;
    el('countAll').textContent = active.length;
    el('countDone').textContent = currentTasks.length - active.length;
    el('trashCount').textContent = tasks.length - currentTasks.length;
    el('progressCount').textContent = `${completedLocallyToday.length} / ${count}`;
    el('progressPercent').textContent = `${pct}%`;
    el('progressFill').style.width = `${pct}%`;
    el('greeting').innerHTML = `${greeting()}<span class="hero-accent">.</span>`;
    el('dateLabel').textContent = new Intl.DateTimeFormat('bg-BG', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }).format(new Date());
  }

  function getVisibleTasks() {
    const today = localDate();
    const q = el('searchInput').value.trim().toLocaleLowerCase('bg-BG');
    const category = el('categoryFilter').value;
    let result = tasks.filter((task) => {
      if (task.deletedAt) return false;
      if (view === 'today' && (isFinished(task) || !task.date || task.date > today)) return false;
      if (view === 'upcoming' && (isFinished(task) || !task.date || task.date <= today)) return false;
      if (view === 'all' && isFinished(task)) return false;
      if (view === 'done' && !isFinished(task)) return false;
      if (view === 'done' && historyFilter === 'completed' && !task.done) return false;
      if (view === 'done' && historyFilter === 'skipped' && !task.skipped) return false;
      if (view === 'calendar' && (isFinished(task) || task.date !== selectedDate)) return false;
      if (category !== 'all' && task.category !== category) return false;
      if (q && !searchText(task).includes(q)) return false;
      return true;
    });
    const prio = (task) => task.priority === 'high' ? 0 : 1;
    result.sort((a, b) => {
      // Finished tasks retain completion order regardless of pin and sort choices.
      if (view === 'done') return (b.skippedAt || b.completedAt || '').localeCompare(a.skippedAt || a.completedAt || '');
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const dateDiff = (a.date || '9999').localeCompare(b.date || '9999');
      const priorityDiff = prio(a) - prio(b);
      const newestDiff = b.createdAt.localeCompare(a.createdAt);
      if (sortMode === 'priority') return priorityDiff || dateDiff || newestDiff;
      if (sortMode === 'newest') return newestDiff || dateDiff || priorityDiff;
      return dateDiff || priorityDiff || newestDiff;
    });
    return result;
  }

  function taskHtml(task) {
    const today = localDate();
    const late = !isFinished(task) && task.date && task.date < today;
    const dateClass = late ? ' overdue' : !task.date ? ' unscheduled' : task.date === today ? ' due-today' : '';
    const dateText = late ? `Просрочено · ${prettyDate(task.date)}` : prettyDate(task.date);
    const total = task.subtasks.length;
    const checked = task.subtasks.filter((part) => part.done).length;
    const expanded = expandedSubtasks.has(task.id);
    const onlyPending = !isFinished(task) && pendingOnlySubtasks.has(task.id);
    const visibleParts = onlyPending ? task.subtasks.filter((part) => !part.done) : task.subtasks;
    const checklist = total ? `<div class="subtask-panel">
      <button type="button" class="subtask-toggle" data-action="expand" data-id="${escapeHtml(task.id)}" aria-expanded="${expanded}" aria-label="${expanded ? 'Скрий' : 'Покажи'} подзадачите: ${escapeHtml(task.title)}">
        <span class="subtask-counter">${icon('check')} ${checked} / ${total} подзадачи</span><span class="subtask-toggle-label">${expanded ? 'Скрий' : 'Покажи списъка'}</span>
      </button>
      ${expanded ? `<div class="subtask-checklist">
        ${!isFinished(task) ? `<div class="subtask-action-bar">
          ${checked > 0 ? `<button type="button" class="subtask-pending" data-action="pending-only" data-id="${escapeHtml(task.id)}" aria-pressed="${onlyPending}">${onlyPending ? 'Покажи всички' : 'Само оставащите'} (${total - checked})</button>` : ''}
          <details class="subtask-options">
            <summary aria-label="Още действия за подзадачите на ${escapeHtml(task.title)}">⋯ Действия за списъка</summary>
            <div class="subtask-tools" role="group" aria-label="Действия за подзадачите">
              ${checked < total ? `<button type="button" data-action="subtasks-complete" data-id="${escapeHtml(task.id)}" aria-label="Отметни всички подзадачи на ${escapeHtml(task.title)}">Отметни всички</button>` : ''}
              ${checked > 0 ? `<button type="button" data-action="subtasks-reset" data-id="${escapeHtml(task.id)}" aria-label="Изчисти отметките на подзадачите на ${escapeHtml(task.title)}">Изчисти отметките</button>` : ''}
              <button type="button" data-action="share-list" data-id="${escapeHtml(task.id)}">Сподели списъка</button>
              <button type="button" data-action="copy-list" data-id="${escapeHtml(task.id)}">Копирай списъка</button>
            </div>
          </details>
        </div>` : ''}
        ${visibleParts.length ? visibleParts.map((part) => inlineSubtaskEdit?.taskId === task.id && inlineSubtaskEdit?.subId === part.id
          ? `<form class="inline-edit-subtask-form" data-inline-edit-task="${escapeHtml(task.id)}" data-inline-edit-sub="${escapeHtml(part.id)}" autocomplete="off">
              <input class="inline-edit-subtask-input" name="newText" type="text" maxlength="100" required value="${escapeHtml(inlineSubtaskEdit.value)}" aria-label="Промени текста на подзадачата">
              <button class="inline-edit-subtask-save" type="submit">Запази</button>
              <button class="inline-edit-subtask-cancel" type="button" data-action="cancel-subtask-edit" data-id="${escapeHtml(task.id)}" data-sub-id="${escapeHtml(part.id)}">Отказ</button>
            </form>`
          : `<div class="subtask-row">
              <button type="button" class="subtask-item${part.done ? ' checked' : ''}" data-action="subtask" data-id="${escapeHtml(task.id)}" data-sub-id="${escapeHtml(part.id)}" ${isFinished(task) ? 'disabled' : ''} aria-pressed="${part.done}" aria-label="${part.done ? 'Премахни отметката от' : 'Отметни'}: ${escapeHtml(part.text)}"><span class="subtask-box">${icon('check')}</span><span class="subtask-item-text">${escapeHtml(part.text)}</span></button>
              ${!isFinished(task) ? `<button type="button" class="subtask-rename-button" data-action="edit-subtask" data-id="${escapeHtml(task.id)}" data-sub-id="${escapeHtml(part.id)}" aria-label="Промени: ${escapeHtml(part.text)}" title="Промени текста">${icon('pencil')}</button>` : ''}
            </div>`).join('') : '<p class="subtask-all-done">Всички подзадачи са отметнати.</p>'}
        ${!isFinished(task) ? total < MAX_SUBTASKS ? `<form class="quick-subtask-form" data-quick-subtask-form="${escapeHtml(task.id)}" autocomplete="off">
          <input class="quick-subtask-input" name="item" type="text" maxlength="100" placeholder="Добави продукт или подзадача…" aria-label="Нов ред в ${escapeHtml(task.title)}" value="${escapeHtml(inlineSubtaskDrafts.get(task.id) || '')}" required>
          <button type="submit">+ Добави</button>
        </form>` : `<p class="subtask-limit">Достигнати са 30 подзадачи.</p>` : ''}
      </div>` : ''}
      </div>` : '';
    return `<article class="task-card${task.done ? ' completed' : ''}${task.skipped ? ' skipped' : ''}${!isFinished(task) && task.pinned ? ' pinned' : ''}">
      <button type="button" class="task-check" data-action="toggle" data-id="${escapeHtml(task.id)}" aria-label="${task.skipped ? 'Върни пропуснатата задача' : task.done ? 'Върни като неизпълнена' : 'Маркирай като изпълнена'}: ${escapeHtml(task.title)}">${icon(task.skipped ? 'repeat' : 'check')}</button>
      <div class="task-content">
        <button type="button" class="task-main" data-action="edit" data-id="${escapeHtml(task.id)}" aria-label="Редактирай: ${escapeHtml(task.title)}">
          <span class="task-title">${escapeHtml(task.title)}</span>
          ${task.note ? `<span class="task-note">${escapeHtml(task.note)}</span>` : ''}
          <span class="task-meta">
            <span class="pill ${task.category}">${escapeHtml(CATEGORIES[task.category])}</span>
            <span class="pill${dateClass}">${icon('calendar')}${escapeHtml(dateText)}</span>
            ${task.repeat !== 'none' ? `<span class="pill repeating">${icon('repeat')}${escapeHtml(REPEATS[task.repeat])}</span>` : ''}
            ${task.priority === 'high' ? '<span class="pill important">★ Важна</span>' : ''}
            ${task.skipped ? '<span class="pill skipped-pill">Пропусната · не е изпълнена</span>' : ''}
            ${task.pinned && !isFinished(task) ? `<span class="pill pinned-pill">${icon('pin')} Закрепена</span>` : ''}
          </span>
        </button>
        ${checklist}
        ${late ? `<div class="overdue-quick-actions" aria-label="Бързо пренасрочване"><span>Премести:</span>
          <button type="button" data-action="reschedule" data-offset="0" data-id="${escapeHtml(task.id)}" aria-label="Премести за днес: ${escapeHtml(task.title)}">Днес</button>
          <button type="button" data-action="reschedule" data-offset="1" data-id="${escapeHtml(task.id)}" aria-label="Премести за утре: ${escapeHtml(task.title)}">Утре</button>
        </div>` : ''}
      </div>
      ${!isFinished(task) ? `<button type="button" class="task-pin${task.pinned ? ' active' : ''}" data-action="pin" data-id="${escapeHtml(task.id)}" aria-pressed="${task.pinned}" aria-label="${task.pinned ? 'Откачи' : 'Закрепи'} задача: ${escapeHtml(task.title)}" title="${task.pinned ? 'Махни отгоре' : 'Закрепи най-отгоре'}">${icon('pin')}</button>` : ''}
      ${!isFinished(task) ? `<button type="button" class="task-move" data-action="move" data-id="${escapeHtml(task.id)}" aria-label="Премести за друга дата: ${escapeHtml(task.title)}" title="Промени датата">${icon('calendar')}</button>` : ''}
      <details class="task-options">
        <summary aria-label="Още действия за задача: ${escapeHtml(task.title)}" title="Още действия">${icon('more')}</summary>
        <div class="task-options-panel" role="group" aria-label="Допълнителни действия за ${escapeHtml(task.title)}">
          <button type="button" data-action="duplicate" data-id="${escapeHtml(task.id)}">${icon('copy')} Копирай</button>
          <button type="button" data-action="save-template" data-id="${escapeHtml(task.id)}">${icon('sparkle')} Запази шаблон</button>
          ${total ? `<button type="button" data-action="share-list" data-id="${escapeHtml(task.id)}">${icon('copy')} Сподели списъка</button>
          <button type="button" data-action="copy-list" data-id="${escapeHtml(task.id)}">${icon('copy')} Копирай списъка</button>` : ''}
          ${!isFinished(task) && task.repeat !== 'none' ? `<button type="button" data-action="skip" data-id="${escapeHtml(task.id)}">${icon('repeat')} Пропусни този път</button>` : ''}
          <button type="button" class="danger-action" data-action="delete" data-id="${escapeHtml(task.id)}">${icon('trash')} Изтрий</button>
        </div>
      </details>
    </article>`;
  }
  // Group tasks visually without changing their order in storage.
  // Pinned tasks appear first, followed by date groups in a stable order.
  function groupHtml(visible) {
    const today = localDate();
    const pinned = visible.filter((task) => task.pinned);
    const rest = visible.filter((task) => !task.pinned);
    const sections = [
      { key: 'pinned', title: 'Закрепени', hint: 'Задачи, които искаш да виждаш първи', items: pinned },
      { key: 'overdue', title: 'Просрочени', hint: 'Планирани за минали дни', items: rest.filter((task) => task.date && task.date < today) },
      { key: 'today', title: 'За днес', hint: 'Задачи с днешна дата', items: rest.filter((task) => task.date === today) }
    ];
    if (view === 'all') {
      sections.push(
        { key: 'upcoming', title: 'Предстоящи', hint: 'Планирани за следващи дни', items: rest.filter((task) => task.date > today) },
        { key: 'unscheduled', title: 'Без дата', hint: 'Задачи, които още не си планирал', items: rest.filter((task) => !task.date) }
      );
    }
    return sections.filter((section) => section.items.length).map((section) => `
      <section class="task-group task-group-${section.key}" data-section="${section.key}" aria-label="${section.title}">
        <div class="task-group-heading">
          <div class="task-group-heading-copy"><h3>${section.title}</h3><p>${section.hint}</p></div>
          <span class="task-group-count" aria-label="${section.items.length} задачи">${section.items.length}</span>
        </div>
        <div class="task-group-cards">${section.items.map(taskHtml).join('')}</div>
      </section>`).join('');
  }

  function renderUndatedNotice() {
    const notice = el('undatedNotice');
    if (view !== 'today') { notice.hidden = true; return; }
    const category = el('categoryFilter').value;
    const q = el('searchInput').value.trim().toLocaleLowerCase('bg-BG');
    const count = tasks.filter((task) => {
      if (isFinished(task) || task.deletedAt || task.date) return false;
      if (category !== 'all' && category !== task.category) return false;
      if (q && !searchText(task).includes(q)) return false;
      return true;
    }).length;
    notice.hidden = !count;
    if (count) el('undatedNoticeText').textContent = `${count} ${count === 1 ? 'задача без дата' : 'задачи без дата'} — можеш да ги планираш по-късно.`;
  }

  function renderOverdueTools(visible) {
    const panel = el('overdueTools');
    const show = view === 'today' || view === 'all';
    const count = show ? visible.filter((task) => !isFinished(task) && task.date && task.date < localDate()).length : 0;
    panel.hidden = count === 0;
    if (count) el('overdueToolsTitle').textContent = `${count} ${count === 1 ? 'просрочена задача' : 'просрочени задачи'}`;
  }

  function renderHistoryFilters() {
    const panel = el('historyFilters');
    panel.hidden = view !== 'done';
    if (panel.hidden) return;
    // Counts respect the category and search filters, but not the selected history type.
    const category = el('categoryFilter').value;
    const query = el('searchInput').value.trim().toLocaleLowerCase('bg-BG');
    const entries = tasks.filter((task) => {
      if (task.deletedAt || !isFinished(task)) return false;
      if (category !== 'all' && task.category !== category) return false;
      if (query && !searchText(task).includes(query)) return false;
      return true;
    });
    el('historyCountAll').textContent = entries.length;
    el('historyCountCompleted').textContent = entries.filter((task) => task.done).length;
    el('historyCountSkipped').textContent = entries.filter((task) => task.skipped).length;
    panel.querySelectorAll('[data-history-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.historyFilter === historyFilter));
    });
  }

  function renderList() {
    if (searchRenderTimer !== null) {
      clearTimeout(searchRenderTimer);
      searchRenderTimer = null;
    }
    try {
    el('sectionEyebrow').textContent = VIEWS[view][0];
    el('listTitle').textContent = view === 'calendar'
      ? `Задачи за ${new Intl.DateTimeFormat('bg-BG', { day: 'numeric', month: 'long' }).format(new Date(`${selectedDate}T12:00:00`))}`
      : VIEWS[view][1];
    el('sortControls').hidden = view === 'done';
    renderHistoryFilters();
    document.querySelectorAll('[data-view]').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    const visible = getVisibleTasks();
    renderOverdueTools(visible);
    renderUndatedNotice();
    if (visible.length) {
      el('taskList').innerHTML = view === 'today' || view === 'all' ? groupHtml(visible) : visible.map(taskHtml).join('');
      return;
    }
    const hasFilter = Boolean(el('searchInput').value.trim()) || el('categoryFilter').value !== 'all';
    const filteredHistory = view === 'done' && historyFilter !== 'all';
    const messages = {
      today: ['Спокойно начало!', 'Нямаш задачи за днес. Добави една малка стъпка.'],
      upcoming: ['Нищо предстоящо', 'Тук ще виждаш задачите, планирани за следващите дни.'],
      all: ['Започни с първата задача', 'Запиши какво трябва да направиш и MyDay ще го подреди.'],
      done: ['Историята е празна', 'Тук ще виждаш изпълнените и пропуснатите повторения.'],
      calendar: ['Няма задачи за тази дата', 'Избери друг ден или добави нова задача.']
    };
    const [title, description] = hasFilter
      ? ['Няма намерени задачи', 'Опитай друга дума или категория.']
      : filteredHistory
        ? (historyFilter === 'completed'
          ? ['Няма изпълнени задачи', 'Избери „Всички“, за да видиш и пропуснатите.']
          : ['Няма пропуснати задачи', 'Избери „Всички“, за да видиш цялата история.'])
        : messages[view];
    el('taskList').innerHTML = `<div class="empty-state">
      <span class="empty-icon">${icon(view === 'done' ? 'check' : 'sparkle')}</span>
      <h3>${title}</h3><p>${description}</p>
      ${!hasFilter && view !== 'done' ? '<button type="button" id="emptyAdd">+ Добави задача</button>' : ''}
    </div>`;
    } finally {
      restoreChecklistPosition();
    }
  }
  function quickDefaultDate() {
    if (view === 'calendar') return selectedDate;
    if (view === 'upcoming') {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return localDate(tomorrow);
    }
    return localDate();
  }
  function quickDate() {
    // Explicit selection overrides the current tab; "auto" follows the tab.
    const mode = el('quickWhen').value;
    if (mode === 'none') return '';
    if (mode === 'today') return localDate();
    if (mode === 'tomorrow') {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return localDate(tomorrow);
    }
    return quickDefaultDate();
  }
  function renderQuickAdd() {
    const date = quickDate();
    el('quickDateLabel').textContent = `Дата: ${prettyDate(date)}`;
  }
  function submitQuickTask(event) {
    event.preventDefault();
    const input = el('quickTitle');
    const title = input.value.trim();
    if (!title) return;
    const category = el('quickCategory').value;
    const task = normalizeTask({
      id: makeId(), title, note: '', subtasks: [], date: quickDate(),
      category, priority: 'normal', pinned: false, repeat: 'none', done: false,
      createdAt: new Date().toISOString()
    });
    if (task && saveTasks([task, ...tasks])) {
      input.value = '';
      if (view === 'done') { view = 'today'; render(); }
      input.focus();
      showToast(`Новата задача е записана. Дата: ${prettyDate(task.date)}.`);
    }
  }
  // Keep backup reminders separate from tasks and templates. A browser download
  // cannot be verified by JavaScript: this records when export was *requested*,
  // not proof that a JSON file has been saved to Downloads.
  function lastBackupTime() {
    try {
      const raw = localStorage.getItem(LAST_BACKUP_KEY);
      if (!raw) return null;
      const time = Date.parse(raw);
      return Number.isFinite(time) && time <= Date.now() + 60000 ? time : null;
    } catch { return null; }
  }
  function renderBackupReminder() {
    const last = lastBackupTime();
    const status = el('backupLastStatus');
    if (last !== null) {
      status.textContent = `Последно подготвен backup: ${new Intl.DateTimeFormat('bg-BG', {dateStyle:'medium', timeStyle:'short'}).format(new Date(last))}. Провери Downloads.`;
    } else {
      status.textContent = 'Няма записана дата за последен backup. Старите версии не следяха това.';
    }
    const reminder = el('backupReminder');
    const now = Date.now();
    let snoozedUntil = 0;
    try { snoozedUntil = Number(localStorage.getItem(BACKUP_SNOOZE_KEY)) || 0; } catch { /* optional */ }
    const overdue = last === null || now - last >= BACKUP_REMIND_DAYS * 86400000;
    reminder.hidden = Boolean(storageProblem || templatesProblem || !(tasks.length || templates.length) || !overdue || snoozedUntil > now);
    if (!reminder.hidden) {
      el('backupReminderText').textContent = last === null
        ? 'MyDay няма информация за последен backup. Създай JSON копие и провери Downloads.'
        : 'Минаха поне 7 дни от последното подготвено копие. Добре е да създадеш ново.';
    }
  }
  function snoozeBackupReminder() {
    try { localStorage.setItem(BACKUP_SNOOZE_KEY, String(Date.now() + 3 * 86400000)); } catch { /* session only */ }
    el('backupReminder').hidden = true;
    showToast('Напомнянето е отложено за 3 дни.');
  }

  function render() {
    renderBackupReminder();
    renderStorageWarning();
    updateOfflineStatus();
    renderHeader();
    renderCalendar();
    renderQuickAdd();
    renderTemplates();
    renderList();
    if (el('trashDialog').open) renderTrash();
  }

  function renderSubtaskEditor(items) {
    el('subtaskEditorList').innerHTML = items.map((part) => `<div class="subtask-editor-row" data-sub-id="${escapeHtml(part.id)}">
      <input type="checkbox" class="subtask-editor-check" ${part.done ? 'checked' : ''} aria-label="Изпълнена подзадача: ${escapeHtml(part.text)}">
      <input type="text" class="text-input subtask-editor-text" value="${escapeHtml(part.text)}" maxlength="100" aria-label="Текст на подзадача">
      <button class="subtask-editor-remove" type="button" data-remove-subtask aria-label="Премахни подзадача: ${escapeHtml(part.text)}" title="Премахни">${icon('trash')}</button>
    </div>`).join('');
  }
  function addSubtaskFromField() {
    const value = el('newSubtask').value.trim();
    if (!value) { el('newSubtask').focus(); return false; }
    const rows = el('subtaskEditorList').querySelectorAll('.subtask-editor-row');
    if (rows.length >= MAX_SUBTASKS) { showToast('Можеш да добавиш до 30 подзадачи.'); return false; }
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<div class="subtask-editor-row" data-sub-id="${escapeHtml(makeId())}">
      <input type="checkbox" class="subtask-editor-check" aria-label="Изпълнена подзадача: ${escapeHtml(value)}">
      <input type="text" class="text-input subtask-editor-text" value="${escapeHtml(value)}" maxlength="100" aria-label="Текст на подзадача">
      <button class="subtask-editor-remove" type="button" data-remove-subtask aria-label="Премахни подзадача: ${escapeHtml(value)}" title="Премахни">${icon('trash')}</button>
    </div>`;
    el('subtaskEditorList').append(wrapper.firstElementChild);
    el('newSubtask').value = '';
    el('newSubtask').focus();
    return true;
  }
  function addBulkSubtasks() {
    const bulk = el('bulkSubtaskText');
    const lines = bulk.value.split(/\r?\n/).map((line) => line.trim().slice(0, 100)).filter(Boolean);
    if (!lines.length) { bulk.focus(); return false; }
    const list = el('subtaskEditorList');
    const existingRows = Array.from(list.querySelectorAll('.subtask-editor-row'));
    const seen = new Set(existingRows.map((row) => row.querySelector('.subtask-editor-text').value.trim().toLocaleLowerCase('bg-BG')).filter(Boolean));
    const unique = [];
    let duplicates = 0;
    for (const value of lines) {
      const key = value.toLocaleLowerCase('bg-BG');
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      unique.push(value);
    }
    const remaining = MAX_SUBTASKS - existingRows.length;
    if (unique.length > remaining) {
      showToast(`Има място за още ${remaining} реда. Намали списъка преди запис.`);
      return false; // Do not silently drop any pasted lines.
    }
    const fragment = document.createDocumentFragment();
    for (const value of unique) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = `<div class="subtask-editor-row" data-sub-id="${escapeHtml(makeId())}">
        <input type="checkbox" class="subtask-editor-check" aria-label="Изпълнена подзадача: ${escapeHtml(value)}">
        <input type="text" class="text-input subtask-editor-text" value="${escapeHtml(value)}" maxlength="100" aria-label="Текст на подзадача">
        <button class="subtask-editor-remove" type="button" data-remove-subtask aria-label="Премахни подзадача: ${escapeHtml(value)}" title="Премахни">${icon('trash')}</button>
      </div>`;
      fragment.append(wrapper.firstElementChild);
    }
    if (unique.length) list.append(fragment);
    bulk.value = '';
    showToast(unique.length ? `Добавени ${unique.length} подзадачи${duplicates ? `, пропуснати повторения: ${duplicates}` : ''}.` : 'Тези подзадачи вече са в списъка.');
    return true;
  }
  function getEditedSubtasks() {
    return Array.from(el('subtaskEditorList').querySelectorAll('.subtask-editor-row'))
      .map((row) => ({
        id: row.dataset.subId || makeId(),
        text: row.querySelector('.subtask-editor-text').value.trim().slice(0, 100),
        done: row.querySelector('.subtask-editor-check').checked
      })).filter((part) => part.text);
  }
  function toggleSubtask(taskId, subId) {
    const existing = tasks.find((task) => task.id === taskId);
    if (!existing || existing.deletedAt || isFinished(existing) || !existing.subtasks.some((part) => part.id === subId)) return;
    const next = tasks.map((task) => task.id !== taskId ? task : {
      ...task, autoGenerated: false,
      subtasks: task.subtasks.map((part) => part.id === subId ? { ...part, done: !part.done } : part)
    });
    saveTasks(next);
  }

  // 1.15: Share only the selected checklist. A private note, other tasks and
  // backup contents are never included. Android sharing happens only on tap.
  function checklistText(task) {
    const remaining = task.subtasks.filter((part) => !part.done).length;
    return `${task.title}\n\n${task.subtasks.map((part) => `${part.done ? '☑' : '☐'} ${part.text}`).join('\n')}\n\nОстават: ${remaining} от ${task.subtasks.length}`;
  }
  async function copyChecklist(task) {
    if (!task.subtasks.length) return;
    const data = checklistText(task);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(data);
      } else {
        const input = document.createElement('textarea');
        input.value = data;
        input.setAttribute('readonly', '');
        input.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.append(input);
        input.select();
        const okay = document.execCommand('copy');
        input.remove();
        if (!okay) throw new Error('Clipboard unavailable');
      }
      showToast('Списъкът е копиран. Личната бележка не е включена.');
    } catch {
      showToast('Не успях да копирам списъка. Опитай отново в Chrome.');
    }
  }
  function shareChecklist(task) {
    if (!task.subtasks.length) return;
    const data = checklistText(task);
    // Invoke navigator.share from the actual button click, not a timer or effect.
    if (typeof navigator.share === 'function') {
      try {
        const outcome = navigator.share({ title: task.title, text: data });
        Promise.resolve(outcome).catch((error) => {
          if (error?.name !== 'AbortError') showToast('Споделянето не успя. Използвай „Копирай списъка“.');
        });
      } catch {
        showToast('Споделянето не е достъпно. Използвай „Копирай списъка“.');
      }
    } else {
      showToast('Този браузър не предлага споделяне. Използвай „Копирай списъка“.');
    }
  }

  // 1.16: Add one checklist row without entering the full task editor.
  function addInlineSubtask(taskId, text) {
    const existing = tasks.find((task) => task.id === taskId);
    const value = text.trim();
    if (!existing || existing.deletedAt || isFinished(existing) || !value) return false;
    if (value.length > 100 || existing.subtasks.length >= MAX_SUBTASKS) {
      showToast('Можеш да добавиш до 30 реда, всеки с до 100 символа.');
      return false;
    }
    const previous = tasks;
    const updated = tasks.map((task) => task.id !== taskId ? task : {
      ...task, autoGenerated: false,
      subtasks: [...task.subtasks, { id: makeId(), text: value, done: false }]
    });
    if (!saveTasks(updated)) return false;
    inlineSubtaskDrafts.delete(taskId);
    expandedSubtasks.add(taskId);
    // saveTasks() redraws the card; point focus back to its new input.
    renderList();
    const freshInput = [...el('taskList').querySelectorAll('form[data-quick-subtask-form]')]
      .find((form) => form.dataset.quickSubtaskForm === taskId)?.querySelector('input');
    freshInput?.focus({ preventScroll: true });
    const savedRaw = lastSavedRaw;
    showToast(`Добавено: ${value}`, {
      label: 'Върни',
      run: () => {
        // Do not undo over newer changes from this or another window.
        if (lastSavedRaw !== savedRaw) {
          showToast('Има по-нови промени. Връщането не е приложено.');
          return;
        }
        if (saveTasks(previous)) showToast('Новият ред е премахнат.');
      }
    });
    return true;
  }

  // 1.17: Quick rename an individual checklist item without opening the task editor.
  function inlineSubtaskInput() {
    return [...el('taskList').querySelectorAll('form[data-inline-edit-task]')]
      .find((form) => form.dataset.inlineEditTask === inlineSubtaskEdit?.taskId &&
        form.dataset.inlineEditSub === inlineSubtaskEdit?.subId)?.querySelector('input[name="newText"]');
  }
  function beginInlineSubtaskEdit(taskId, subId) {
    const task = tasks.find((item) => item.id === taskId);
    const part = task?.subtasks.find((item) => item.id === subId);
    if (!task || task.deletedAt || isFinished(task) || !part) return;
    if (inlineSubtaskEdit && (inlineSubtaskEdit.taskId !== taskId || inlineSubtaskEdit.subId !== subId) &&
        inlineSubtaskEdit.value !== inlineSubtaskEdit.original &&
        !confirm('Има незапазена промяна в друг ред. Откажи я?')) return;
    inlineSubtaskEdit = { taskId, subId, original: part.text, value: part.text };
    expandedSubtasks.add(taskId);
    renderList();
    const input = inlineSubtaskInput();
    input?.focus({ preventScroll: true });
    input?.select();
  }
  function cancelInlineSubtaskEdit() {
    if (!inlineSubtaskEdit) return;
    inlineSubtaskEdit = null;
    renderList();
  }
  function saveInlineSubtaskEdit(taskId, subId) {
    const edit = inlineSubtaskEdit;
    if (!edit || edit.taskId !== taskId || edit.subId !== subId) return;
    const text = edit.value.trim();
    if (!text || text.length > 100) {
      showToast('Въведи текст от 1 до 100 символа.');
      inlineSubtaskInput()?.focus({ preventScroll: true });
      return;
    }
    const task = tasks.find((item) => item.id === taskId);
    const part = task?.subtasks.find((item) => item.id === subId);
    if (!task || task.deletedAt || isFinished(task) || !part || part.text !== edit.original) {
      showToast('Редът е променен или премахнат другаде. Откажи редакцията и го отвори отново.');
      return;
    }
    if (text === edit.original) {
      cancelInlineSubtaskEdit();
      return;
    }
    const before = tasks;
    const updated = tasks.map((item) => item.id !== taskId ? item : {
      ...item, autoGenerated: false,
      subtasks: item.subtasks.map((row) => row.id === subId ? { ...row, text } : row)
    });
    if (!saveTasks(updated)) return; // saveTasks protects against changes in another tab.
    inlineSubtaskEdit = null;
    renderList();
    const expectedRaw = lastSavedRaw;
    showToast('Редът е променен.', {
      label: 'Върни',
      run: () => {
        if (lastSavedRaw !== expectedRaw) {
          showToast('Има по-нови промени. Връщането не е приложено.');
          return;
        }
        if (saveTasks(before)) showToast('Предишният текст е възстановен.');
      }
    });
  }

  // Bulk checklist actions are intentionally separate from completing the parent task.
  // Undo is allowed only while the saved data still matches this exact change.
  function setAllSubtasks(taskId, markDone) {
    const existing = tasks.find((task) => task.id === taskId);
    if (!existing || existing.deletedAt || isFinished(existing) || !existing.subtasks.length) return;
    const changed = existing.subtasks.filter((part) => part.done !== markDone).length;
    if (!changed) return;
    const before = tasks;
    const next = tasks.map((task) => task.id === taskId ? {
      ...task, autoGenerated: false,
      subtasks: task.subtasks.map((part) => ({ ...part, done: markDone }))
    } : task);
    if (!saveTasks(next)) return;
    const expectedRaw = lastSavedRaw;
    showToast(markDone ? `Отметнати са ${changed} подзадачи.` : `Изчистени са ${changed} отметки.`, {
      label: 'Върни',
      run: () => {
        if (lastSavedRaw !== expectedRaw) {
          showToast('Има по-нови промени. Отмяната не е приложена.');
          return;
        }
        if (saveTasks(before)) showToast('Отметките са възстановени.');
      }
    });
  }

  function togglePin(id) {
    const task = tasks.find((item) => item.id === id);
    if (!task || isFinished(task) || task.deletedAt) return;
    const nextPinned = !task.pinned;
    if (saveTasks(tasks.map((item) => item.id === id
      ? { ...item, pinned: nextPinned, autoGenerated: false } : item))) {
      showToast(nextPinned ? 'Задачата е закрепена най-отгоре.' : 'Задачата е откачена.');
    }
  }

  // A complete snapshot includes unsubmitted subtask inputs and changed checkboxes.
  // This prevents losing work when pressing Cancel, Android Back, Escape or the backdrop.
  function captureEditorState() {
    return JSON.stringify({
      title: el('taskTitle').value,
      note: el('taskNote').value,
      date: el('taskDate').value,
      category: el('taskCategory').value,
      priority: el('taskPriority').value,
      repeat: el('taskRepeat').value,
      newSubtask: el('newSubtask').value,
      bulkSubtasks: el('bulkSubtaskText').value,
      subtasks: Array.from(el('subtaskEditorList').querySelectorAll('.subtask-editor-row')).map((row) => ({
        id: row.dataset.subId,
        text: row.querySelector('.subtask-editor-text').value,
        done: row.querySelector('.subtask-editor-check').checked
      }))
    });
  }
  function hasUnsavedEditorChanges() {
    return el('taskDialog').open && captureEditorState() !== editorInitialState;
  }
  function updateDraftStatus() {
    if (!el('taskDialog').open) return;
    const changed = hasUnsavedEditorChanges();
    const status = el('draftStatus');
    status.textContent = changed ? '● Има незапазени промени' : 'Няма незапазени промени';
    status.classList.toggle('dirty', changed);
  }
  function openEditor(task = null) {
    pendingTemplateId = null;
    editorOutdated = false;
    editingId = task ? task.id : null;
    duplicating = false;
    el('duplicateHint').hidden = true;
    el('taskForm').reset();
    el('dialogTitle').textContent = task ? 'Редактирай задача' : 'Нова задача';
    el('saveButton').textContent = task ? 'Запази промените' : 'Добави задачата';
    el('taskTitle').value = task?.title || '';
    el('taskNote').value = task?.note || '';
    el('newSubtask').value = '';
    el('bulkSubtaskText').value = '';
    el('bulkSubtasks').open = false;
    renderSubtaskEditor(task?.subtasks || []);
    const nextDay = new Date();
    if (view === 'upcoming') nextDay.setDate(nextDay.getDate() + 1);
    el('taskDate').value = task ? task.date : (view === 'calendar' ? selectedDate : localDate(nextDay));
    el('taskCategory').value = task?.category || (el('categoryFilter').value !== 'all' ? el('categoryFilter').value : 'personal');
    el('taskPriority').value = task?.priority || 'normal';
    el('taskRepeat').value = task?.repeat || 'none';
    el('toolsMenu').open = false;
    el('taskDialog').showModal();
    editorInitialState = captureEditorState();
    updateDraftStatus();
    requestAnimationFrame(() => el('taskTitle').focus());
  }
  function duplicateTask(source) {
    if (!source || source.deletedAt) return;
    // Start a fresh draft, never edit or overwrite the original task.
    openEditor();
    duplicating = true;
    el('dialogTitle').textContent = 'Копие на задача';
    el('saveButton').textContent = 'Създай копие';
    el('duplicateHint').hidden = false;
    el('taskTitle').value = source.title;
    el('taskNote').value = source.note;
    // All subtasks receive new IDs and cleared checkboxes, even from History.
    renderSubtaskEditor(source.subtasks.map((part) => ({
      id: makeId(), text: part.text, done: false
    })));
    // New copies begin today (or on the selected calendar date).
    el('taskDate').value = view === 'calendar' ? selectedDate : localDate();
    el('taskCategory').value = source.category;
    el('taskPriority').value = source.priority;
    // Do not silently create a second recurring series.
    el('taskRepeat').value = 'none';
    editorInitialState = captureEditorState();
    updateDraftStatus();
  }
  function closeEditor() {
    if (hasUnsavedEditorChanges() && !confirm('Има незапазени промени. Да затворя ли без да ги запазя?')) return;
    el('taskDialog').close();
    editingId = null;
    duplicating = false;
    pendingTemplateId = null;
    editorOutdated = false;
    editorInitialState = '';
  }
  function closeEditorAfterSave() {
    el('taskDialog').close();
    editingId = null;
    duplicating = false;
    pendingTemplateId = null;
    editorOutdated = false;
    editorInitialState = '';
  }
  function handleSubmit(event) {
    event.preventDefault();
    if (editorOutdated) {
      showToast('Задачите са променени в друг прозорец. Затвори редактора и отвори отново, за да няма загуба на данни.');
      return;
    }
    const title = el('taskTitle').value.trim();
    const date = el('taskDate').value;
    if (!title) { el('taskTitle').focus(); return; }
    if (!isValidDate(date)) { showToast('Провери датата.'); return; }
    const repeat = el('taskRepeat').value;
    if (repeat !== 'none' && !date) { showToast('Избери дата за повтарящата се задача.'); el('taskDate').focus(); return; }
    // Include a final typed subtask even if the + Добави button was not tapped.
    if (el('newSubtask').value.trim() && !addSubtaskFromField()) return;
    if (el('bulkSubtaskText').value.trim() && !addBulkSubtasks()) return;
    const subtasks = getEditedSubtasks();
    const previous = tasks.find((task) => task.id === editingId);
    const repeatDay = repeat === 'monthly'
      ? (previous && previous.repeat === 'monthly' && previous.date === date ? previous.repeatDay : dayOfMonth(date))
      : null;
    const common = {
      title,
      note: el('taskNote').value.trim(),
      subtasks,
      date,
      category: el('taskCategory').value,
      priority: el('taskPriority').value,
      repeat,
      repeatDay
    };
    let next;
    if (editingId) {
      if (!tasks.some((task) => task.id === editingId)) return;
      next = tasks.map((task) => task.id === editingId ? { ...task, ...common, autoGenerated: false } : task);
    } else {
      next = [{ id: makeId(), ...common, pinned: false, done: false, skipped: false, skippedAt: null, createdAt: new Date().toISOString(), completedAt: null,
        previousId: null, autoGenerated: false }, ...tasks];
    }
    if (saveTasks(next)) {
      const wasEditing = Boolean(editingId);
      const wasDuplicating = duplicating;
      const sourceTemplateId = !wasEditing ? pendingTemplateId : null;
      closeEditorAfterSave();
      // Count use ONLY after the new task was successfully saved. Cancel = no use.
      let countSaved = true;
      if (sourceTemplateId) {
        const source = templates.find((item) => item.id === sourceTemplateId);
        if (source) countSaved = saveTemplates(templates.map((item) => item.id === sourceTemplateId
          ? {...item, useCount: Math.min(item.useCount + 1, 1000000)} : item));
        else countSaved = false;
      }
      showToast(!countSaved
        ? 'Задачата е записана, но броят използвания на шаблона не се обнови.'
        : wasEditing ? 'Промените са записани на телефона.'
        : wasDuplicating ? 'Копието е създадено на телефона.'
        : 'Новата задача е записана на телефона.');
    }
  }
  function advanceRecurring(existing, skip = false) {
    if (isFinished(existing) || existing.deletedAt || existing.repeat === 'none' || !existing.date) return;
    const nextDate = nextRepeatDate(existing);
    if (skip && !confirm(`Да пропусна ли „${existing.title}“ само за ${prettyDate(existing.date)}?\n\nЗадачата НЕ се отбелязва като изпълнена. Следващо повторение: ${prettyDate(nextDate)}.`)) return;
    const now = new Date().toISOString();
    const successor = {
      ...existing, id: makeId(), date: nextDate, done: false, skipped: false,
      skippedAt: null, completedAt: null,
      subtasks: existing.subtasks.map((part) => ({ ...part, done: false })),
      createdAt: now, previousId: existing.id, autoGenerated: true
    };
    const previous = tasks.map((task) => task.id === existing.id
      ? { ...task, done: !skip, skipped: skip, completedAt: skip ? null : now, skippedAt: skip ? now : null }
      : task);
    if (saveTasks([successor, ...previous])) {
      showToast(skip
        ? `Този път е пропуснат. Следващо повторение: ${prettyDate(nextDate)}.`
        : `Изпълнено! Следващото повторение: ${prettyDate(nextDate)}.`);
    }
  }
  function skipOccurrence(id) {
    const existing = tasks.find((task) => task.id === id);
    if (existing && !isFinished(existing) && !existing.deletedAt && existing.repeat !== 'none' && existing.date) {
      advanceRecurring(existing, true);
    }
  }
  function toggleTask(id) {
    const existing = tasks.find((task) => task.id === id);
    if (!existing || existing.deletedAt) return;
    if (isFinished(existing)) {
      if (existing.repeat !== 'none') {
        const successor = tasks.find((task) => task.previousId === id);
        if (successor && (successor.deletedAt || isFinished(successor) || !successor.autoGenerated)) {
          showToast('Следващото повторение вече е променено или приключено. Не може да върнеш това действие.');
          return;
        }
        // Restore the old occurrence and remove ONLY an untouched generated successor.
        const restored = tasks.filter((task) => task.id !== successor?.id).map((task) =>
          task.id === id ? { ...task, done: false, skipped: false, completedAt: null, skippedAt: null } : task
        );
        if (saveTasks(restored)) showToast('Повторението е върнато, а автоматичното следващо е отменено.');
        return;
      }
      if (saveTasks(tasks.map((task) => task.id === id
        ? { ...task, done: false, skipped: false, completedAt: null, skippedAt: null } : task))) {
        showToast('Задачата е върната.');
      }
      return;
    }
    if (existing.subtasks.some((part) => !part.done)) {
      const left = existing.subtasks.filter((part) => !part.done).length;
      if (!confirm(`Има ${left} неотметнати подзадачи. Да завърша ли цялата задача?`)) return;
    }
    if (existing.repeat !== 'none') {
      if (!existing.date) { showToast('Повтарящата се задача няма дата. Редактирай я.'); return; }
      advanceRecurring(existing, false);
      return;
    }
    const now = new Date().toISOString();
    if (saveTasks(tasks.map((task) => task.id !== id ? task : {
      ...task, done: true, skipped: false, skippedAt: null, completedAt: now
    }))) showToast('Браво! Задачата е изпълнена.');
  }
  function offsetDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return localDate(date);
  }
  function rescheduleOverdue(ids, days, bulk = false) {
    if (days !== 0 && days !== 1) return;
    const today = localDate();
    const idSet = new Set(ids);
    const affected = tasks.filter((task) => idSet.has(task.id) && !isFinished(task) && !task.deletedAt && task.date && task.date < today);
    if (!affected.length) { showToast('Няма просрочени задачи за преместване.'); return; }
    const target = offsetDate(days);
    const repeatingCount = affected.filter((task) => task.repeat !== 'none').length;
    if (bulk) {
      const repeatNote = repeatingCount ? `\nВключени са ${repeatingCount} повтарящи се задачи. Новата дата ще промени бъдещия им график.` : '';
      if (!confirm(`Да преместя ли ${affected.length} видими просрочени задачи за ${days === 0 ? 'днес' : 'утре'}?${repeatNote}\n\nМожеш да отмениш действието веднага след това.`)) return;
    } else if (repeatingCount) {
      if (!confirm(`Тази задача се повтаря. Пренасрочването ще промени основата на бъдещите повторения. Да продължа?`)) return;
    }
    const oldValues = new Map(affected.map((task) => [task.id, {
      date: task.date, repeatDay: task.repeatDay, autoGenerated: task.autoGenerated
    }]));
    const next = tasks.map((task) => !oldValues.has(task.id) ? task : {
      ...task, date: target,
      repeatDay: task.repeat === 'monthly' ? dayOfMonth(target) : null,
      autoGenerated: false
    });
    if (!saveTasks(next)) return;
    const expectedRaw = lastSavedRaw;
    showToast(affected.length === 1
      ? `Задачата е преместена за ${prettyDate(target)}.`
      : `${affected.length} задачи са преместени за ${prettyDate(target)}.`, {
        label: 'Върни', run: () => {
          // Undo is safe only when nothing else has changed since the operation.
          let currentRaw;
          try { currentRaw = localStorage.getItem(TASKS_KEY); }
          catch { showToast('Не мога да проверя записаните данни.'); return; }
          if (storageProblem || lastSavedRaw !== expectedRaw || currentRaw !== expectedRaw) {
            showToast('След преместването има други промени. Върни датите ръчно, за да не загубиш данни.');
            return;
          }
          const restored = tasks.map((task) => oldValues.has(task.id)
            ? { ...task, ...oldValues.get(task.id) } : task);
          if (saveTasks(restored)) showToast('Предишните дати са възстановени.');
        }
      });
  }
  function rescheduleVisibleOverdue(days) {
    if (view !== 'today' && view !== 'all') return;
    const today = localDate();
    const ids = getVisibleTasks()
      .filter((task) => !isFinished(task) && task.date && task.date < today)
      .map((task) => task.id);
    rescheduleOverdue(ids, days, true);
  }
  function openMove(task) {
    if (isFinished(task) || task.deletedAt) return;
    movingId = task.id;
    el('moveTaskName').textContent = task.title;
    el('moveDate').value = task.date || localDate();
    el('moveDialog').showModal();
  }
  function closeMove() {
    el('moveDialog').close();
    movingId = null;
  }
  function handleMove(event) {
    event.preventDefault();
    const task = tasks.find((item) => item.id === movingId);
    const date = el('moveDate').value;
    if (!task || isFinished(task) || task.deletedAt || !date || !isValidDate(date)) { showToast('Избери валидна дата.'); return; }
    if (task.date === date) { closeMove(); return; }
    const next = tasks.map((item) => item.id === movingId
      ? { ...item, date, repeatDay: item.repeat === 'monthly' ? dayOfMonth(date) : null, autoGenerated: false }
      : item);
    if (saveTasks(next)) {
      closeMove();
      showToast(`Задачата е преместена за ${prettyDate(date)}.`);
    }
  }
  function deleteTask(id) {
    const existing = tasks.find((task) => task.id === id && !task.deletedAt);
    if (!existing || !confirm(`Да преместя ли „${existing.title}“ в кошчето? Можеш да я възстановиш по-късно.`)) return;
    const when = new Date().toISOString();
    if (saveTasks(tasks.map((task) => task.id === id ? { ...task, deletedAt: when } : task))) {
      expandedSubtasks.delete(id);
      pendingOnlySubtasks.delete(id);
      showToast('Задачата е преместена в кошчето.', { label: 'Върни', run: () => restoreTask(id) });
    }
  }
  function restoreTask(id) {
    const existing = tasks.find((task) => task.id === id && task.deletedAt);
    if (!existing) { showToast('Задачата вече не е в кошчето.'); return; }
    if (saveTasks(tasks.map((task) => task.id === id ? { ...task, deletedAt: null } : task))) {
      showToast('Задачата е възстановена.');
    }
  }
  function deleteForever(id) {
    const existing = tasks.find((task) => task.id === id && task.deletedAt);
    if (!existing || !confirm(`Изтрий окончателно „${existing.title}“? Това не може да се отмени без предишен backup.`)) return;
    if (saveTasks(tasks.filter((task) => task.id !== id))) {
      expandedSubtasks.delete(id);
      pendingOnlySubtasks.delete(id);
      showToast('Задачата е изтрита окончателно.');
    }
  }
  function renderTrash() {
    const deleted = tasks.filter((task) => Boolean(task.deletedAt))
      .sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
    if (!deleted.length) {
      el('trashList').innerHTML = '<p class="trash-empty">Кошчето е празно.</p>';
      return;
    }
    el('trashList').innerHTML = deleted.map((task) => `<article class="trash-item">
      <div class="trash-item-content">
        <strong>${escapeHtml(task.title)}</strong>
        <span>${escapeHtml(CATEGORIES[task.category])} · ${escapeHtml(prettyDate(task.date))}${task.done ? ' · Изпълнена' : task.skipped ? ' · Пропусната' : ''}</span>
      </div>
      <div class="trash-actions">
        <button type="button" class="trash-restore" data-trash-action="restore" data-id="${escapeHtml(task.id)}">Възстанови</button>
        <button type="button" class="trash-permanent" data-trash-action="forever" data-id="${escapeHtml(task.id)}">Изтрий завинаги</button>
      </div>
    </article>`).join('');
  }
  function openTrash() {
    el('toolsMenu').open = false;
    renderTrash();
    el('trashDialog').showModal();
  }
  function closeTrash() { el('trashDialog').close(); }
  function downloadOriginalData() {
    if (storageProblem !== 'damaged' || damagedRaw === null) return;
    const blob = new Blob([damagedRaw], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `myday-original-data-${localDate()}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('Оригиналните данни са подготвени. Провери Downloads, преди да възстановяваш backup.');
  }
  function renderStorageWarning() {
    const warning = el('storageWarning');
    warning.hidden = !storageProblem;
    if (!storageProblem) return;
    if (storageProblem === 'damaged') {
      el('storageWarningTitle').textContent = 'Записът на задачите не може да се прочете';
      el('storageWarningText').textContent = 'Данните НЕ са изтрити. За да не бъдат презаписани, новите записи са спрени. Първо запази оригиналните данни, после зареди твой валиден MyDay backup.';
      el('downloadRecovery').hidden = false;
      el('restoreRecovery').hidden = false;
    } else {
      el('storageWarningTitle').textContent = 'Браузърът не позволява запис на задачи';
      el('storageWarningText').textContent = 'Отвори MyDay в обикновен прозорец на Chrome (не Incognito) и провери дали съхранението е разрешено.';
      el('downloadRecovery').hidden = true;
      el('restoreRecovery').hidden = true;
    }
  }
  function updateOfflineStatus() {
    // Browser connectivity is only a hint; cached files enable true offline use.
    el('offlineStatus').hidden = navigator.onLine !== false;
  }
  function exportBackup() {
    if (storageProblem) {
      showToast('Backup не е създаден: записът не може да се прочете. Използвай предупреждението горе.');
      el('toolsMenu').open = false;
      return;
    }
    // Soft-deleted tasks remain in this same array, so backups preserve the trash as well.
    if (templatesProblem) {
      showToast('Не мога да запазя пълен backup: шаблоните не могат да се прочетат.');
      el('toolsMenu').open = false;
      return;
    }
    // A second tab can update localStorage while this tab is sleeping in Android.
    // Never download a potentially stale snapshot; refresh and ask for a fresh export.
    try {
      if (localStorage.getItem(TASKS_KEY) !== lastSavedRaw ||
          localStorage.getItem(TEMPLATES_KEY) !== templatesRaw) {
        tasks = readTasks();
        templates = readTemplates();
        render();
        showToast('Данните са обновени в друг прозорец. Провери задачите и натисни „Запази backup“ отново.');
        el('toolsMenu').open = false;
        return;
      }
    } catch {
      showToast('Няма достъп до записите. Не мога да подготвя надежден backup.');
      el('toolsMenu').open = false;
      return;
    }
    const created = new Date();
    const backup = { app: 'MyDay', version: 9, exportedAt: created.toISOString(), tasks, templates };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const hh = String(created.getHours()).padStart(2, '0');
    const mm = String(created.getMinutes()).padStart(2, '0');
    const ss = String(created.getSeconds()).padStart(2, '0');
    a.download = `myday-backup-${localDate(created)}-${hh}${mm}${ss}.json`;
    document.body.append(a);
    try {
      a.click();
      try {
        localStorage.setItem(LAST_BACKUP_KEY, created.toISOString());
        localStorage.removeItem(BACKUP_SNOOZE_KEY);
      } catch { /* The backup download can still work without a timestamp. */ }
      renderBackupReminder();
      showToast(`Backup подготвен: ${tasks.length} задачи, ${templates.length} шаблона. Провери Downloads.`);
    } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      el('toolsMenu').open = false;
    }
  }
  // One validator for both file inspection and import: a report should never
  // label a file valid if the import logic would reject its structure.
  async function readValidatedBackup(file) {
    if (file.size > 3 * 1024 * 1024) throw new Error('Файлът е твърде голям (макс. 3 MB).');
    const backup = JSON.parse(await file.text());
    if (backup.app !== 'MyDay' || ![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(backup.version) || !Array.isArray(backup.tasks) || backup.tasks.length > 5000) {
      throw new Error('Това не е съвместим MyDay backup файл.');
    }
    // Every record needs its own persistent ID, including backups from 0.1.
    // Otherwise re-importing could silently create duplicate copies.
    if (backup.tasks.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.id !== 'string' || !item.id.trim())) {
      throw new Error('Backup съдържа запис без валиден идентификатор. Нищо не е променено.');
    }
    const imported = backup.tasks.map(normalizeTask);
    if (imported.some((task) => !task)) throw new Error('Някои задачи във файла са невалидни. Нищо не е променено.');
    const importIds = new Set();
    for (const task of imported) {
      if (importIds.has(task.id)) throw new Error('Backup файлът съдържа повтарящи се идентификатори. Нищо не е променено.');
      importIds.add(task.id);
    }
    // Versions 1–7 had no template collection. Their import must not alter it.
    const importedTemplates = backup.version >= 8 ? validateTemplates(backup.templates) : [];
    return { backup, imported, importedTemplates };
  }

  async function verifyBackupFile(file) {
    if (!file) return;
    const dialog = el('backupVerifyDialog');
    const status = el('backupVerifyStatus');
    const details = el('backupVerifyDetails');
    el('backupVerifyFileName').textContent = file.name;
    details.hidden = true;
    status.textContent = 'Проверявам файла...';
    status.className = 'backup-verify-status';
    el('toolsMenu').open = false;
    dialog.showModal();
    try {
      const { backup, imported, importedTemplates } = await readValidatedBackup(file);
      const active = imported.filter((task) => !task.deletedAt && !isFinished(task)).length;
      const completed = imported.filter((task) => !task.deletedAt && task.done).length;
      const skipped = imported.filter((task) => !task.deletedAt && task.skipped).length;
      const trash = imported.filter((task) => Boolean(task.deletedAt)).length;
      const validDate = typeof backup.exportedAt === 'string' && !Number.isNaN(Date.parse(backup.exportedAt));
      const backupDate = validDate ? new Intl.DateTimeFormat('bg-BG', {
        dateStyle: 'medium', timeStyle: 'short'
      }).format(new Date(backup.exportedAt)) : 'Не е записана';
      el('backupVerifyVersion').textContent = String(backup.version);
      el('backupVerifyDate').textContent = backupDate;
      el('backupVerifyActive').textContent = String(active);
      el('backupVerifyFinished').textContent = `${completed} / ${skipped}`;
      el('backupVerifyTrash').textContent = String(trash);
      el('backupVerifyTemplates').textContent = String(importedTemplates.length);
      status.textContent = imported.length || importedTemplates.length
        ? 'Файлът е валиден. Няма направени промени по задачите.'
        : 'Файлът е валиден, но не съдържа задачи или шаблони.';
      status.className = 'backup-verify-status valid';
      details.hidden = false;
    } catch (error) {
      status.textContent = `Проверката не е успешна: ${error instanceof Error ? error.message : 'Невалиден файл'}`;
      status.className = 'backup-verify-status invalid';
    } finally {
      el('verifyBackupFile').value = '';
    }
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const { backup, imported, importedTemplates } = await readValidatedBackup(file);
      if (templatesProblem && importedTemplates.length) throw new Error('Съществуващите шаблони не могат да се прочетат. Няма да ги презапиша.');
      const templateIds = new Set(templates.map((item) => item.id));
      const freshTemplates = importedTemplates.filter((item) => !templateIds.has(item.id));
      if (templates.length + freshTemplates.length > MAX_TEMPLATES) throw new Error(`Можеш да имаш до ${MAX_TEMPLATES} шаблона. Не е направен импорт.`);
      // A damaged local record must be consciously replaced, never merged with []
      // or overwritten by adding a new task. Backups are validated first.
      if (storageProblem === 'damaged') {
        if (!imported.length) throw new Error('Backup файлът няма задачи. Няма да заменя повредения запис с празен списък.');
        if (!confirm('ВНИМАНИЕ: локалният запис е повреден.\n\nУвери се, че си изтеглил оригиналните данни като .txt файл.\n\nТози импорт ще ЗАМЕНИ повредения запис с проверените задачи от backup файла. Да продължа?')) return;
        try {
          const serialized = JSON.stringify(imported);
          localStorage.setItem(TASKS_KEY, serialized);
          tasks = imported;
          lastSavedRaw = serialized;
          storageProblem = null;
          damagedRaw = null;
          render();
          if (freshTemplates.length && !saveTemplates([...freshTemplates, ...templates])) {
            showToast('Задачите са възстановени, но шаблоните не бяха добавени. Опитай отново след проверка.');
          } else {
            showToast(`Възстановени ${imported.length} задачи и ${freshTemplates.length} шаблона.`);
          }
        } catch { showToast('Възстановяването не успя. Оригиналните данни са запазени.'); }
        return;
      }
      if (storageProblem) throw new Error('Браузърът не позволява запис.');
      const known = new Set(tasks.map((task) => task.id));
      const fresh = imported.filter((task) => !known.has(task.id));
      const alreadyHere = imported.length - fresh.length;
      if (!fresh.length && !freshTemplates.length) {
        showToast(`Няма нови записи. ${alreadyHere} задачи вече съществуват.`);
        return;
      }
      const validExportDate = typeof backup.exportedAt === 'string' && !Number.isNaN(Date.parse(backup.exportedAt));
      const exported = validExportDate ? new Intl.DateTimeFormat('bg-BG', { dateStyle: 'medium' }).format(new Date(backup.exportedAt)) : 'неизвестна дата';
      const trashed = fresh.filter((task) => task.deletedAt).length;
      const details = `Проверен MyDay backup\nДата: ${exported}\nНови задачи: ${fresh.length} (в кошчето: ${trashed})\nСъществуващи задачи: ${alreadyHere}\nНови шаблони: ${freshTemplates.length}\n\nЩе добавя САМО новите записи. Съществуващите няма да бъдат заменени.\n\nДа продължа?`;
      if (!confirm(details)) return;
      if (fresh.length && !saveTasks([...fresh, ...tasks])) return;
      if (freshTemplates.length && !saveTemplates([...freshTemplates, ...templates])) {
        showToast('Импортът на шаблоните не успя. Новите задачи, ако има такива, са запазени.');
        return;
      }
      showToast(`Добавени ${fresh.length} задачи и ${freshTemplates.length} шаблона. Старите записи са запазени.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Грешка при зареждане на файла.');
    } finally {
      el('importFile').value = '';
      el('toolsMenu').open = false;
    }
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    el('themeButton').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#101725' : '#f6f8fc';
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* Browser storage blocked */ }
  }

  // PWA install prompt is offered by Chrome; the site cannot force it.
  let pendingInstallPrompt = null;
  let installedThisSession = false;
  let workerRegistrationError = '';
  const installFindings = {https: '', manifest: '', worker: '', offer: ''};
  const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches === true || navigator.standalone === true;
  function installStatus(id, value, kind='') {
    const node = el(id);
    if (!node) return;
    node.textContent = value;
    node.classList.toggle('ok', kind === 'ok');
    node.classList.toggle('problem', kind === 'problem');
  }
  function refreshInstallBanner() {
    if (el('installNudge')) el('installNudge').hidden = isStandalone() || installedThisSession || !/Android/i.test(navigator.userAgent);
    if (el('installPromptButton')) el('installPromptButton').hidden = !pendingInstallPrompt || isStandalone() || installedThisSession;
    if (el('installAdvice')) el('installAdvice').textContent = isStandalone()
      ? 'MyDay вече е отворен като самостоятелно приложение.'
      : installedThisSession ? 'Chrome потвърди инсталацията. Отвори MyDay от иконата на телефона.'
      : pendingInstallPrompt
        ? 'Chrome предлага инсталиране. Използвай бутона „Инсталирай MyDay“.'
        : 'Ако Chrome не предлага инсталиране автоматично, използвай менюто ⋮. Провери резултатите по-долу.';
    if (el('installOffer')) installStatus('installOffer', isStandalone() ? 'Отворено като приложение' : installedThisSession ? 'Инсталирано в тази сесия' : pendingInstallPrompt ? 'Наличен бутон за инсталация' : 'Няма автоматичен диалог', pendingInstallPrompt || isStandalone() || installedThisSession ? 'ok' : '');
    installFindings.offer = el('installOffer')?.textContent || '';
    renderInstallReport();
  }
  function renderInstallReport() {
    const report = el('installReport');
    if (!report) return;
    report.value = [
      'MyDay 1.10 · PWA проверка',
      `Адрес: ${location.origin}${location.pathname}`,
      `Браузър: ${navigator.userAgent}`,
      `Онлайн: ${navigator.onLine === false ? 'не' : 'да / неустановено'}`,
      `Самостоятелен режим: ${isStandalone() ? 'да' : 'не'}`,
      `HTTPS: ${installFindings.https || 'непроверено'}`,
      `Manifest: ${installFindings.manifest || 'непроверено'}`,
      `Service Worker: ${installFindings.worker || 'непроверено'}`,
      `Инсталация: ${installFindings.offer || 'непроверено'}`
    ].join('\n');
  }
  async function checkInstall() {
    const secure = window.isSecureContext === true && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
    installFindings.https = secure ? 'OK' : 'Няма HTTPS / secure context';
    installStatus('installHttps', installFindings.https, secure ? 'ok' : 'problem');
    installStatus('installManifest', 'Проверявам...');
    installStatus('installWorker', 'Проверявам...');
    try {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) throw new Error('Няма link към manifest');
      const manifestUrl = new URL(link.getAttribute('href'), document.baseURI);
      const response = await fetch(manifestUrl.href, {cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!(data.name || data.short_name) || !data.start_url || !['standalone','fullscreen','minimal-ui'].includes(data.display)) throw new Error('Непълни полета');
      const iconEntries = (Array.isArray(data.icons) ? data.icons : []);
      for (const size of ['192x192','512x512']) {
        const entry = iconEntries.find((item) => item.sizes?.split(/\s+/).includes(size));
        if (!entry?.src) throw new Error(`Липсва икона ${size}`);
        const iconUrl = new URL(entry.src, manifestUrl.href);
        const iconResponse = await fetch(iconUrl, {cache:'no-store'});
        if (!iconResponse.ok || !(iconResponse.headers.get('content-type') || '').includes('image/')) throw new Error(`Икона ${size} (HTTP ${iconResponse.status})`);
      }
      installFindings.manifest = 'OK: manifest + две икони';
      installStatus('installManifest', installFindings.manifest, 'ok');
    } catch (e) {
      installFindings.manifest = navigator.onLine === false ? 'Невъзможна проверка офлайн' : `Проблем: ${String(e?.message || e).slice(0,85)}`;
      installStatus('installManifest', installFindings.manifest, navigator.onLine === false ? '' : 'problem');
    }
    try {
      if (!('serviceWorker' in navigator)) throw new Error('Браузърът няма Service Worker');
      const reg = await navigator.serviceWorker.getRegistration(new URL('./', document.baseURI).href);
      if (!reg) throw new Error(workerRegistrationError || 'Все още няма регистрация');
      if (reg.active) {
        installFindings.worker = 'OK: активен';
        installStatus('installWorker', installFindings.worker, 'ok');
      } else {
        installFindings.worker = reg.installing ? 'Инсталира се — отвори пак приложението' : 'Регистриран, изчаква активиране';
        installStatus('installWorker', installFindings.worker);
      }
    } catch (e) {
      installFindings.worker = `Проблем: ${String(e?.message || e).slice(0,85)}`;
      installStatus('installWorker', installFindings.worker, 'problem');
    }
    refreshInstallBanner();
  }
  function openInstallDialog() {
    el('toolsMenu').open = false;
    refreshInstallBanner();
    el('installDialog').showModal();
    void checkInstall();
  }
  function beginInstall() {
    // Must be invoked directly within a real click to satisfy user activation.
    const event = pendingInstallPrompt;
    if (!event) { showToast('Отвори ⋮ в Chrome и избери Install and create shortcut.'); return; }
    pendingInstallPrompt = null;
    refreshInstallBanner();
    try {
      event.prompt();
      Promise.resolve(event.userChoice).then((choice) => {
        showToast(choice?.outcome === 'accepted' ? 'Инсталацията е заявена в Chrome.' : 'Инсталацията не е потвърдена.');
        refreshInstallBanner();
      }).catch(() => refreshInstallBanner());
    } catch { showToast('Chrome не отвори инсталация. Опитай през менюто ⋮.'); }
  }
  function initInstallUi() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      pendingInstallPrompt = event;
      refreshInstallBanner();
    });
    window.addEventListener('appinstalled', () => {
      pendingInstallPrompt = null;
      installedThisSession = true;
      refreshInstallBanner();
      showToast('MyDay е инсталиран.');
    });
    window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', refreshInstallBanner);
    el('installMenuButton').addEventListener('click', openInstallDialog);
    el('installNudgeButton').addEventListener('click', openInstallDialog);
    el('installPromptButton').addEventListener('click', beginInstall);
    el('installCheckAgain').addEventListener('click', () => { void checkInstall(); });
    const close = () => el('installDialog').close();
    el('closeInstall').addEventListener('click', close);
    el('closeInstallBottom').addEventListener('click', close);
    el('installDialog').addEventListener('click', (event) => { if (event.target === el('installDialog')) close(); });
    el('copyInstallReport').addEventListener('click', async () => {
      const text = el('installReport').value;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);
        showToast('Резултатът е копиран. Постави го в ChatGPT.');
      } catch {
        el('installReport').focus();
        el('installReport').select();
        showToast('Текстът е маркиран. Избери „Копирай“ от менюто на Android.');
      }
    });
    refreshInstallBanner();
  }

  function init() {
    let theme = 'light';
    try { theme = localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
    catch { /* use light theme */ }
    applyTheme(theme === 'dark' ? 'dark' : 'light');
    try {
      const savedSort = localStorage.getItem(SORT_KEY);
      if (SORT_MODES.includes(savedSort)) sortMode = savedSort;
    } catch { /* keep default sort */ }
    el('sortSelect').value = sortMode;
    try {
      const savedHistoryFilter = localStorage.getItem(HISTORY_FILTER_KEY);
      if (HISTORY_FILTERS.includes(savedHistoryFilter)) historyFilter = savedHistoryFilter;
    } catch { /* keep the default filter */ }
    el('historyFilters').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-history-filter]');
      if (!button || !HISTORY_FILTERS.includes(button.dataset.historyFilter)) return;
      historyFilter = button.dataset.historyFilter;
      try { localStorage.setItem(HISTORY_FILTER_KEY, historyFilter); } catch { /* use this session */ }
      renderList();
    });
    el('sortSelect').addEventListener('change', () => {
      sortMode = SORT_MODES.includes(el('sortSelect').value) ? el('sortSelect').value : 'date';
      try { localStorage.setItem(SORT_KEY, sortMode); } catch { /* keep for current session */ }
      renderList();
    });

    el('themeButton').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { view = button.dataset.view; render(); }));
    el('calendarToggle').addEventListener('click', () => {
      if (view === 'calendar') view = 'today';
      else { selectedDate = localDate(); monthCursor = selectedDate.slice(0, 7); view = 'calendar'; }
      render();
    });
    el('prevMonth').addEventListener('click', () => shiftCalendarMonth(-1));
    el('nextMonth').addEventListener('click', () => shiftCalendarMonth(1));
    el('calendarToday').addEventListener('click', () => selectCalendarDate(localDate()));
    el('calendarAdd').addEventListener('click', () => openEditor());
    el('calendarGrid').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-calendar-date]');
      if (button) selectCalendarDate(button.dataset.calendarDate);
    });
    el('searchInput').addEventListener('input', scheduleSearchRender);
    el('overdueMoveToday').addEventListener('click', () => rescheduleVisibleOverdue(0));
    el('overdueMoveTomorrow').addEventListener('click', () => rescheduleVisibleOverdue(1));
    el('viewUndated').addEventListener('click', () => {
      view = 'all';
      render();
      const section = el('taskList').querySelector('[data-section="unscheduled"]');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    el('categoryFilter').addEventListener('change', () => {
      if (el('categoryFilter').value !== 'all') el('quickCategory').value = el('categoryFilter').value;
      renderList();
    });
    for (const id of ['addButton', 'mobileAdd']) el(id).addEventListener('click', () => openEditor());
    // Compact menus are native <details>: keyboard and touch friendly, no new stored state.
    document.addEventListener('click', (event) => {
      const opened = document.querySelectorAll('.task-options[open], .subtask-options[open]');
      const current = event.target.closest('.task-options, .subtask-options');
      for (const menu of opened) {
        if (menu !== current) menu.open = false;
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      const opened = document.querySelectorAll('.task-options[open], .subtask-options[open]');
      if (!opened.length) return;
      opened.forEach((menu) => { menu.open = false; });
      event.preventDefault();
    });
    el('taskList').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (button) {
        const task = tasks.find((item) => item.id === button.dataset.id);
        if (!task) return;
        rememberChecklistPosition(button);
        if (button.dataset.action === 'toggle') toggleTask(task.id);
        if (button.dataset.action === 'skip') skipOccurrence(task.id);
        if (button.dataset.action === 'delete') deleteTask(task.id);
        if (button.dataset.action === 'edit') openEditor(task);
        if (button.dataset.action === 'duplicate') duplicateTask(task);
        if (button.dataset.action === 'save-template') saveTaskAsTemplate(task);
        if (button.dataset.action === 'copy-list') copyChecklist(task);
        if (button.dataset.action === 'share-list') shareChecklist(task);
        if (button.dataset.action === 'move') openMove(task);
        if (button.dataset.action === 'reschedule') rescheduleOverdue([task.id], Number(button.dataset.offset));
        if (button.dataset.action === 'pin') togglePin(task.id);
        if (button.dataset.action === 'expand') {
          if (expandedSubtasks.has(task.id)) expandedSubtasks.delete(task.id);
          else expandedSubtasks.add(task.id);
          renderList();
        }
        if (button.dataset.action === 'edit-subtask') beginInlineSubtaskEdit(task.id, button.dataset.subId);
        if (button.dataset.action === 'cancel-subtask-edit') cancelInlineSubtaskEdit();
        if (button.dataset.action === 'subtask') toggleSubtask(task.id, button.dataset.subId);
        if (button.dataset.action === 'subtasks-complete') setAllSubtasks(task.id, true);
        if (button.dataset.action === 'subtasks-reset') setAllSubtasks(task.id, false);
        if (button.dataset.action === 'pending-only') {
          if (pendingOnlySubtasks.has(task.id)) pendingOnlySubtasks.delete(task.id);
          else pendingOnlySubtasks.add(task.id);
          renderList();
        }
      } else if (event.target.closest('#emptyAdd')) openEditor();
    });
    // Preserve drafts during re-renders triggered by checkbox operations.
    el('taskList').addEventListener('input', (event) => {
      if (event.target.matches('.inline-edit-subtask-input')) {
        const form = event.target.closest('form[data-inline-edit-task]');
        if (form && inlineSubtaskEdit && form.dataset.inlineEditTask === inlineSubtaskEdit.taskId &&
            form.dataset.inlineEditSub === inlineSubtaskEdit.subId) inlineSubtaskEdit.value = event.target.value;
        return;
      }
      if (!event.target.matches('.quick-subtask-input')) return;
      const form = event.target.closest('form[data-quick-subtask-form]');
      if (form) inlineSubtaskDrafts.set(form.dataset.quickSubtaskForm, event.target.value);
    });
    el('taskList').addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && event.target.matches('.inline-edit-subtask-input')) {
        event.preventDefault();
        event.stopPropagation();
        cancelInlineSubtaskEdit();
      }
    });
    el('taskList').addEventListener('submit', (event) => {
      const renameForm = event.target.closest('form[data-inline-edit-task]');
      if (renameForm) {
        event.preventDefault();
        if (inlineSubtaskEdit) inlineSubtaskEdit.value = renameForm.querySelector('input[name="newText"]')?.value || '';
        saveInlineSubtaskEdit(renameForm.dataset.inlineEditTask, renameForm.dataset.inlineEditSub);
        return;
      }
      const form = event.target.closest('form[data-quick-subtask-form]');
      if (!form) return;
      event.preventDefault();
      const value = form.querySelector('input[name="item"]')?.value || '';
      addInlineSubtask(form.dataset.quickSubtaskForm, value);
    });
    el('templatesButton').addEventListener('click', () => {
      renderTemplates();
      el('templatesDialog').showModal();
    });
    el('templateSort').addEventListener('change', () => {
      templateSort = ['popular', 'recent'].includes(el('templateSort').value) ? el('templateSort').value : 'popular';
      try { localStorage.setItem(TEMPLATE_SORT_KEY, templateSort); } catch { /* preference is optional */ }
      renderTemplates();
    });
    const closeTemplates = () => el('templatesDialog').close();
    el('closeTemplates').addEventListener('click', closeTemplates);
    el('closeTemplatesBottom').addEventListener('click', closeTemplates);
    el('templatesDialog').addEventListener('click', (event) => {
      if (event.target === el('templatesDialog')) closeTemplates();
      const button = event.target.closest('[data-template-action]');
      if (!button) return;
      if (button.dataset.templateAction === 'use') useTemplate(button.dataset.templateId);
      if (button.dataset.templateAction === 'edit') openTemplateEditor(button.dataset.templateId);
      if (button.dataset.templateAction === 'remove') removeTemplate(button.dataset.templateId);
    });
    el('templateEditForm').addEventListener('submit', saveEditedTemplate);
    el('templateEditForm').addEventListener('input', updateTemplateDraftStatus);
    el('templateEditForm').addEventListener('change', updateTemplateDraftStatus);
    el('closeTemplateEdit').addEventListener('click', closeTemplateEditor);
    el('cancelTemplateEdit').addEventListener('click', closeTemplateEditor);
    el('templateEditDialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      closeTemplateEditor();
    });
    el('templateEditDialog').addEventListener('click', (event) => {
      if (event.target === el('templateEditDialog')) closeTemplateEditor();
    });
    el('taskForm').addEventListener('submit', handleSubmit);
    el('quickAddForm').addEventListener('submit', submitQuickTask);
    el('quickWhen').addEventListener('change', renderQuickAdd);
    el('bulkSubtaskAdd').addEventListener('click', addBulkSubtasks);
    el('addSubtask').addEventListener('click', addSubtaskFromField);
    el('newSubtask').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); addSubtaskFromField(); }
    });
    el('subtaskEditorList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-subtask]');
      if (button) button.closest('.subtask-editor-row').remove();
    });
    el('moveForm').addEventListener('submit', handleMove);
    el('closeMove').addEventListener('click', closeMove);
    el('cancelMove').addEventListener('click', closeMove);
    el('moveDialog').addEventListener('click', (event) => { if (event.target === el('moveDialog')) closeMove(); });
    el('moveDialog').addEventListener('close', () => { movingId = null; });
    document.querySelectorAll('[data-move-offset]').forEach((button) => button.addEventListener('click', () => {
      const date = new Date();
      date.setDate(date.getDate() + Number(button.dataset.moveOffset));
      el('moveDate').value = localDate(date);
    }));
    el('closeDialog').addEventListener('click', closeEditor);
    el('cancelDialog').addEventListener('click', closeEditor);
    el('taskDialog').addEventListener('input', updateDraftStatus);
    el('taskDialog').addEventListener('change', updateDraftStatus);
    // Delegated click also catches removing/adding subtasks and clearing a date.
    el('taskDialog').addEventListener('click', updateDraftStatus);
    el('taskDialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      closeEditor();
    });
    window.addEventListener('beforeunload', (event) => {
      if (!hasUnsavedEditorChanges()) return;
      event.preventDefault();
      event.returnValue = ''; // Browser decides whether a warning can be displayed.
    });
    el('clearDate').addEventListener('click', () => { el('taskDate').value = ''; });
    el('taskDialog').addEventListener('click', (event) => { if (event.target === el('taskDialog')) closeEditor(); });
    el('downloadRecovery').addEventListener('click', downloadOriginalData);
    el('restoreRecovery').addEventListener('click', () => el('importFile').click());
    window.addEventListener('online', updateOfflineStatus);
    window.addEventListener('offline', updateOfflineStatus);
    window.addEventListener('storage', (event) => {
      if (event.key === LAST_BACKUP_KEY || event.key === BACKUP_SNOOZE_KEY) { renderBackupReminder(); return; }
      if (event.key === TEMPLATES_KEY) {
        templates = readTemplates();
        renderTemplates();
        showToast('Шаблоните са обновени от друг прозорец.');
        return;
      }
      if (event.key !== TASKS_KEY) return;
      if (el('taskDialog').open) editorOutdated = true;
      tasks = readTasks();
      render();
      showToast(editorOutdated ? 'Има промени в друг прозорец. Затвори редактора и отвори задачата отново.' : 'Задачите са обновени от друг прозорец.');
    });
    el('trashButton').addEventListener('click', openTrash);
    el('closeTrash').addEventListener('click', closeTrash);
    el('closeTrashBottom').addEventListener('click', closeTrash);
    el('trashDialog').addEventListener('click', (event) => { if (event.target === el('trashDialog')) closeTrash(); });
    el('trashList').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-trash-action]');
      if (!button) return;
      if (button.dataset.trashAction === 'restore') restoreTask(button.dataset.id);
      if (button.dataset.trashAction === 'forever') deleteForever(button.dataset.id);
    });
    el('backupReminderSave').addEventListener('click', exportBackup);
    el('backupReminderLater').addEventListener('click', snoozeBackupReminder);
    el('exportButton').addEventListener('click', exportBackup);
    el('verifyBackupButton').addEventListener('click', () => el('verifyBackupFile').click());
    el('verifyBackupFile').addEventListener('change', (event) => { void verifyBackupFile(event.target.files?.[0]); });
    const closeBackupVerify = () => el('backupVerifyDialog').close();
    el('closeBackupVerify').addEventListener('click', closeBackupVerify);
    el('closeBackupVerifyBottom').addEventListener('click', closeBackupVerify);
    el('backupVerifyDialog').addEventListener('click', (event) => {
      if (event.target === el('backupVerifyDialog')) closeBackupVerify();
    });
    el('importButton').addEventListener('click', () => el('importFile').click());
    el('importFile').addEventListener('change', (event) => importBackup(event.target.files?.[0]));
    document.addEventListener('click', (event) => { if (!el('toolsMenu').contains(event.target)) el('toolsMenu').open = false; });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
    initInstallUi();
    try { templateSort = ['popular', 'recent'].includes(localStorage.getItem(TEMPLATE_SORT_KEY)) ? localStorage.getItem(TEMPLATE_SORT_KEY) : 'popular'; } catch { /* default */ }
    el('templateSort').value = templateSort;
    render();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
          .then(() => { if (el('installDialog').open) void checkInstall(); })
          .catch((error) => {
            workerRegistrationError = String(error?.message || error).slice(0,85);
            if (el('installDialog').open) void checkInstall();
          });
      });
    }
  }
  init();
})();
