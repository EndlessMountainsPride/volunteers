/* ==========================================================================
   Endless Mountains Pride — Volunteer Hub Application Logic
   Supports Live Google Apps Script + Google Sheets backend AND full
   Interactive Preview Mode out of the box.
   ========================================================================== */

(function () {
  'use strict';

  const CONFIG = window.EMP_VOLUNTEER_CONFIG || {};
  const STORAGE_KEYS = {
    session: 'emp_vol_session_v1',
    customScriptUrl: 'emp_vol_script_url_v1',
    demoSignups: 'emp_vol_demo_signups_v1',
    alertsEnabled: 'emp_vol_alerts_enabled_v1',
    firedAlerts: 'emp_vol_fired_alerts_v1'
  };

  // ========================================================================
  // Application State
  // ========================================================================
  const state = {
    mode: 'preview', // 'live' | 'preview'
    scriptUrl: '',
    settings: Object.assign({}, CONFIG.FALLBACK_SETTINGS || {}),
    slots: [],
    summary: { totalSlots: 0, totalSpots: 0, filledSpots: 0, openSpots: 0 },

    // Filters & UI
    activeTab: 'shifts',
    selectedDate: 'ALL',
    viewMode: 'location', // 'location' | 'time'
    categoryFilter: 'All',
    searchQuery: '',
    openOnly: false,
    selectedSlotKeys: new Set(),

    // Active Volunteer Session
    volunteer: null, // { name, email, phone, notes }
    editToken: '',
    mySignups: [],

    // Swap Modal state
    swapTargetSignup: null,
    swapSearch: '',

    // Reminder state
    alertsEnabled: false,
    firedAlerts: new Set(),
    reminderIntervalId: null
  };

  // ========================================================================
  // DOM Helpers
  // ========================================================================
  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, type) {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (type === 'error' ? ' error' : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, 3800);
  }

  function openModal(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    const el = $(id);
    if (!el) return;
    el.classList.add('hidden');
    const anyOpen = document.querySelector('.modal-backdrop:not(.hidden)');
    if (!anyOpen) document.body.style.overflow = '';
  }

  // ========================================================================
  // Shift-Splitting & Date/Time Engine (1:1 parity with apps-script/Code.gs)
  // ========================================================================
  function parseShiftLengthHours(raw, fallback) {
    const val = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!val) return fallback;
    if (val === 'full' || val === 'all' || val === 'none' || val === '0' || val === 'single') return 0;
    const num = parseFloat(val);
    return !isNaN(num) && num > 0 ? num : fallback;
  }

  function parseTimeToMinutes(raw) {
    const str = String(raw == null ? '' : raw).trim().toLowerCase();
    const m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const period = m[3] ? m[3].toLowerCase() : null;
    if (period === 'pm' && h < 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  function parseTimeRange(raw) {
    const parts = String(raw || '').trim().split(/\s*(?:-|–|—|\bto\b)\s*/i);
    if (parts.length !== 2) return null;
    const startMin = parseTimeToMinutes(parts[0]);
    const endMin = parseTimeToMinutes(parts[1]);
    if (startMin === null || endMin === null || endMin <= startMin) return null;
    return { startMin, endMin };
  }

  function formatMinutes12h(totalMin) {
    const h24 = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const period = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  }

  function pad4(totalMin) {
    const h = String(Math.floor(totalMin / 60)).padStart(2, '0');
    const m = String(totalMin % 60).padStart(2, '0');
    return `${h}${m}`;
  }

  function formatFriendlyDate(isoDate, includeYear) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '')) return isoDate || '';
    const [y, mo, d] = isoDate.split('-').map(Number);
    const dt = new Date(y, mo - 1, d);
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (includeYear) opts.year = 'numeric';
    return dt.toLocaleDateString('en-US', opts);
  }

  function formatDurationHours(startMin, endMin) {
    const hrs = Math.max(0, (endMin - startMin) / 60);
    const rounded = Math.round(hrs * 10) / 10;
    return rounded === 1 ? '1 hr' : `${rounded} hrs`;
  }

  function expandShiftDefinitions(shiftDefs, defaultLenRaw) {
    const defaultLen = parseShiftLengthHours(defaultLenRaw, 2);
    const slots = [];
    const seen = new Set();

    (shiftDefs || []).forEach((row, idx) => {
      const isoDate = String(row.date || '').trim();
      const location = String(row.location || '').trim();
      const needed = parseInt(row.needed, 10);
      const parsed = parseTimeRange(row.timeRange);
      if (!isoDate || !location || isNaN(needed) || needed <= 0 || !parsed) return;

      const shiftLenHrs = parseShiftLengthHours(row.shiftLength, defaultLen);
      const step = shiftLenHrs > 0 ? Math.round(shiftLenHrs * 60) : (parsed.endMin - parsed.startMin);

      let cursor = parsed.startMin;
      while (cursor < parsed.endMin) {
        let blockEnd = Math.min(cursor + step, parsed.endMin);
        if (parsed.endMin - blockEnd > 0 && parsed.endMin - blockEnd < 30) {
          blockEnd = parsed.endMin;
        }
        const slotKey = `${isoDate}|${location}|${pad4(cursor)}-${pad4(blockEnd)}`;
        if (!seen.has(slotKey)) {
          seen.add(slotKey);
          slots.push({
            slotKey,
            rowIndex: idx + 2,
            date: isoDate,
            location,
            category: row.category || 'General',
            capacity: needed,
            startMinutes: cursor,
            endMinutes: blockEnd,
            startTime: formatMinutes12h(cursor),
            endTime: formatMinutes12h(blockEnd),
            description: row.description || '',
            checkInNote: row.checkInNote || ''
          });
        }
        cursor = blockEnd;
      }
    });

    slots.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
      return a.location.localeCompare(b.location);
    });

    return slots;
  }

  // ========================================================================
  // Backend Client (Live Google Apps Script + Local Interactive Preview Mode)
  // ========================================================================
  function resolveScriptUrl() {
    const saved = localStorage.getItem(STORAGE_KEYS.customScriptUrl);
    if (saved && saved.trim()) return saved.trim();
    return (CONFIG.APPS_SCRIPT_URL || '').trim();
  }

  function loadDemoSignups() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.demoSignups);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveDemoSignups(list) {
    try {
      localStorage.setItem(STORAGE_KEYS.demoSignups, JSON.stringify(list));
    } catch {
      // ignore storage quota errors
    }
  }

  function generateCode(len) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  function buildDemoSchedulePayload() {
    const settings = Object.assign({}, CONFIG.FALLBACK_SETTINGS || {});
    const baseSlots = expandShiftDefinitions(CONFIG.FALLBACK_SHIFTS || [], settings.defaultShiftLength);
    const signups = loadDemoSignups();
    const counts = {};
    signups.forEach((s) => {
      if (s.status === 'Confirmed') counts[s.slotKey] = (counts[s.slotKey] || 0) + 1;
    });

    const slots = baseSlots.map((slot) => {
      const filled = counts[slot.slotKey] || 0;
      const remaining = Math.max(0, slot.capacity - filled);
      return Object.assign({}, slot, { filled, remaining, available: remaining > 0 });
    });

    const totalSpots = slots.reduce((sum, s) => sum + s.capacity, 0);
    const filledSpots = slots.reduce((sum, s) => sum + s.filled, 0);
    return {
      ok: true,
      settings,
      slots,
      summary: {
        totalSlots: slots.length,
        totalSpots,
        filledSpots,
        openSpots: Math.max(0, totalSpots - filledSpots)
      }
    };
  }

  function findOverlapMessage(newSlots, existingSignups) {
    const all = [];
    existingSignups.forEach((s) => {
      const sm = s.startMinutes != null ? s.startMinutes : parseTimeToMinutes(s.startTime);
      const em = s.endMinutes != null ? s.endMinutes : parseTimeToMinutes(s.endTime);
      if (sm != null && em != null) {
        all.push({ date: s.date, startMinutes: sm, endMinutes: em, label: `${s.location} (${s.startTime} – ${s.endTime})` });
      }
    });
    newSlots.forEach((s) => {
      all.push({ date: s.date, startMinutes: s.startMinutes, endMinutes: s.endMinutes, label: `${s.location} (${s.startTime} – ${s.endTime})` });
    });
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        if (a.date === b.date && a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes) {
          return `Time conflict: ${a.label} overlaps with ${b.label}.`;
        }
      }
    }
    return null;
  }

  function demoFilterConfirmed(signups, email, slotMap) {
    return signups
      .filter((s) => s.status === 'Confirmed' && s.email.toLowerCase() === email.toLowerCase())
      .map((s) => {
        const slot = slotMap[s.slotKey];
        return {
          signupId: s.signupId,
          slotKey: s.slotKey,
          date: s.date,
          location: s.location,
          startTime: s.startTime,
          endTime: s.endTime,
          startMinutes: parseTimeToMinutes(s.startTime),
          endMinutes: parseTimeToMinutes(s.endTime),
          description: s.description || (slot ? slot.description : ''),
          category: slot ? slot.category : 'General',
          checkInNote: slot ? slot.checkInNote : '',
          notes: s.notes || '',
          signedUpAt: s.signedUpAt
        };
      })
      .sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date) : (a.startMinutes || 0) - (b.startMinutes || 0)));
  }

  async function apiRequest(action, payload) {
    if (state.mode === 'live' && state.scriptUrl) {
      if (action === 'schedule' || action === 'ping') {
        const url = `${state.scriptUrl}${state.scriptUrl.includes('?') ? '&' : '?'}action=${encodeURIComponent(action)}&_t=${Date.now()}`;
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
        return await res.json();
      }
      // Simple text/plain POST avoids CORS preflight issues with Google Apps Script
      const res = await fetch(state.scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, payload || {}))
      });
      if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
      return await res.json();
    }

    // ---- Interactive Local Preview Mode ----
    return handleDemoApi(action, payload || {});
  }

  function handleDemoApi(action, body) {
    const schedule = buildDemoSchedulePayload();
    const slotMap = {};
    schedule.slots.forEach((s) => { slotMap[s.slotKey] = s; });
    const signups = loadDemoSignups();

    if (action === 'schedule') return schedule;

    if (action === 'signup') {
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const phone = String(body.phone || '').trim();
      const notes = String(body.notes || '').trim();
      const slotKeys = Array.from(new Set(body.slotKeys || []));

      if (name.length < 2) return { ok: false, error: 'Please enter your full name.' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
      if (phone.replace(/\D/g, '').length < 7) return { ok: false, error: 'Please enter a valid phone number.' };
      if (slotKeys.length === 0) return { ok: false, error: 'Please select at least one shift slot.' };

      const myExisting = signups.filter((s) => s.status === 'Confirmed' && s.email === email);
      const requested = [];
      for (const key of slotKeys) {
        const slot = slotMap[key];
        if (!slot) return { ok: false, error: 'Selected shift not found.' };
        if (myExisting.some((s) => s.slotKey === key)) {
          return { ok: false, error: `You are already signed up for ${slot.location} (${slot.startTime} – ${slot.endTime}).` };
        }
        if (slot.remaining <= 0) {
          return { ok: false, error: `${slot.location} (${slot.startTime} – ${slot.endTime}) is now full.`, schedule };
        }
        requested.push(slot);
      }

      const overlapErr = findOverlapMessage(requested, myExisting);
      if (overlapErr) return { ok: false, error: overlapErr };

      const prevRow = signups.slice().reverse().find((s) => s.email === email);
      const editToken = prevRow ? prevRow.editToken : generateCode(6);
      const nowIso = new Date().toISOString();

      requested.forEach((slot) => {
        signups.push({
          signupId: 'EMP-' + generateCode(6),
          slotKey: slot.slotKey,
          date: slot.date,
          location: slot.location,
          startTime: slot.startTime,
          endTime: slot.endTime,
          description: slot.description,
          name,
          email,
          phone,
          editToken,
          status: 'Confirmed',
          signedUpAt: nowIso,
          notes
        });
      });
      saveDemoSignups(signups);

      const fresh = buildDemoSchedulePayload();
      const freshMap = {};
      fresh.slots.forEach((s) => { freshMap[s.slotKey] = s; });

      return {
        ok: true,
        emailSent: false,
        volunteer: { name, email, phone, notes },
        editToken,
        mySignups: demoFilterConfirmed(signups, email, freshMap),
        schedule: fresh
      };
    }

    if (action === 'lookup') {
      const email = String(body.email || '').trim().toLowerCase();
      const token = String(body.token || '').trim().toUpperCase();
      const matched = signups.filter((s) => s.editToken.toUpperCase() === token && (!email || s.email === email));
      if (matched.length === 0) {
        return { ok: false, error: 'No matching signup found for that email and Manage Code.' };
      }
      const latest = matched[matched.length - 1];
      return {
        ok: true,
        volunteer: { name: latest.name, email: latest.email, phone: latest.phone, notes: latest.notes || '' },
        editToken: latest.editToken,
        mySignups: demoFilterConfirmed(signups, latest.email, slotMap)
      };
    }

    if (action === 'updateSignups' || action === 'cancelSignup') {
      const email = String(body.email || '').trim().toLowerCase();
      const token = String(body.token || '').trim().toUpperCase();
      const addSlotKeys = Array.from(new Set(body.addSlotKeys || []));
      const removeIds = action === 'cancelSignup'
        ? (body.signupIds || (body.signupId ? [body.signupId] : []))
        : (body.removeSignupIds || []);

      const owned = signups.filter((s) => s.editToken.toUpperCase() === token && (!email || s.email === email));
      if (owned.length === 0) return { ok: false, error: 'Invalid Manage Code.' };

      const latest = owned[owned.length - 1];
      const volEmail = latest.email;

      // Simulate removals to check capacity & overlap cleanly
      const simulated = signups.map((s) =>
        removeIds.includes(s.signupId) && s.email === volEmail ? Object.assign({}, s, { status: 'Cancelled' }) : s
      );
      const counts = {};
      simulated.forEach((s) => {
        if (s.status === 'Confirmed') counts[s.slotKey] = (counts[s.slotKey] || 0) + 1;
      });
      const myRemaining = simulated.filter((s) => s.status === 'Confirmed' && s.email === volEmail);

      const slotsToAdd = [];
      for (const key of addSlotKeys) {
        const slot = slotMap[key];
        if (!slot) return { ok: false, error: 'Replacement slot not found.' };
        const filled = counts[key] || 0;
        if (slot.capacity - filled <= 0) {
          return { ok: false, error: `${slot.location} (${slot.startTime} – ${slot.endTime}) is already full.` };
        }
        if (myRemaining.some((s) => s.slotKey === key)) {
          return { ok: false, error: 'You are already signed up for that slot.' };
        }
        slotsToAdd.push(slot);
      }

      const overlapErr = findOverlapMessage(slotsToAdd, myRemaining);
      if (overlapErr) return { ok: false, error: overlapErr };

      // Commit removals & additions
      signups.forEach((s) => {
        if (removeIds.includes(s.signupId) && s.email === volEmail) {
          s.status = 'Cancelled';
        }
      });
      const nowIso = new Date().toISOString();
      slotsToAdd.forEach((slot) => {
        signups.push({
          signupId: 'EMP-' + generateCode(6),
          slotKey: slot.slotKey,
          date: slot.date,
          location: slot.location,
          startTime: slot.startTime,
          endTime: slot.endTime,
          description: slot.description,
          name: body.name || latest.name,
          email: volEmail,
          phone: body.phone || latest.phone,
          editToken: latest.editToken,
          status: 'Confirmed',
          signedUpAt: nowIso,
          notes: body.notes !== undefined ? body.notes : (latest.notes || '')
        });
      });
      saveDemoSignups(signups);

      const fresh = buildDemoSchedulePayload();
      const freshMap = {};
      fresh.slots.forEach((s) => { freshMap[s.slotKey] = s; });
      return {
        ok: true,
        volunteer: { name: latest.name, email: volEmail, phone: latest.phone, notes: latest.notes || '' },
        editToken: latest.editToken,
        mySignups: demoFilterConfirmed(signups, volEmail, freshMap),
        schedule: fresh
      };
    }

    if (action === 'updateProfile') {
      const email = String(body.email || '').trim().toLowerCase();
      const token = String(body.token || '').trim().toUpperCase();
      const matched = signups.filter((s) => s.editToken.toUpperCase() === token && (!email || s.email === email));
      if (matched.length === 0) return { ok: false, error: 'Invalid Manage Code.' };
      matched.forEach((s) => {
        s.name = body.name;
        s.phone = body.phone;
        s.notes = body.notes || '';
      });
      saveDemoSignups(signups);
      const volEmail = matched[0].email;
      return {
        ok: true,
        volunteer: { name: body.name, email: volEmail, phone: body.phone, notes: body.notes || '' },
        editToken: matched[0].editToken,
        mySignups: demoFilterConfirmed(signups, volEmail, slotMap)
      };
    }

    if (action === 'sendAccessLink') {
      const email = String(body.email || '').trim().toLowerCase();
      const found = signups.slice().reverse().find((s) => s.email === email);
      if (found) {
        return {
          ok: true,
          message: `Preview Mode: Your Manage Code is ${found.editToken} (in Live Mode, this link is emailed automatically!).`
        };
      }
      return {
        ok: true,
        message: `If there are shifts registered under ${email}, your Manage Code & link would be emailed automatically in Live Mode.`
      };
    }

    return { ok: false, error: 'Unknown action.' };
  }

  // ========================================================================
  // Session Persistence
  // ========================================================================
  function saveSession() {
    if (!state.volunteer || !state.editToken) {
      localStorage.removeItem(STORAGE_KEYS.session);
      return;
    }
    localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
      volunteer: state.volunteer,
      editToken: state.editToken,
      mySignups: state.mySignups
    }));
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.session);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && data.volunteer && data.editToken) {
        state.volunteer = data.volunteer;
        state.editToken = data.editToken;
        state.mySignups = Array.isArray(data.mySignups) ? data.mySignups : [];
      }
    } catch {
      // ignore invalid session
    }
  }

  function clearSession() {
    state.volunteer = null;
    state.editToken = '';
    state.mySignups = [];
    localStorage.removeItem(STORAGE_KEYS.session);
  }

  // ========================================================================
  // Sync & Initialization
  // ========================================================================
  async function syncSchedule(silent) {
    const dot = $('sync-status-dot');
    const label = $('sync-status-label');
    if (dot) dot.className = 'sync-dot syncing';
    if (label) label.textContent = 'Syncing…';

    try {
      const data = await apiRequest('schedule');
      if (!data || !data.ok) throw new Error((data && data.error) || 'Failed to load schedule');
      applyScheduleData(data);

      // Refresh active volunteer's signups if logged in
      if (state.editToken) {
        try {
          const me = await apiRequest('lookup', {
            email: state.volunteer ? state.volunteer.email : '',
            token: state.editToken
          });
          if (me && me.ok) {
            state.volunteer = me.volunteer;
            state.editToken = me.editToken;
            state.mySignups = me.mySignups || [];
            saveSession();
          }
        } catch {
          // keep cached session if offline
        }
      }

      updateConnectionUI();
      renderAll();
      if (!silent) {
        showToast(state.mode === 'live' ? 'Synced live schedule from Google Sheets' : 'Schedule refreshed');
      }
    } catch (err) {
      console.error('Sync failed:', err);
      if (state.slots.length === 0) {
        applyScheduleData(buildDemoSchedulePayload());
      }
      updateConnectionUI();
      renderAll();
      if (!silent) {
        showToast('Could not reach Google Sheet — showing cached schedule.', 'error');
      }
    }
  }

  function applyScheduleData(data) {
    if (data.settings) state.settings = Object.assign({}, state.settings, data.settings);
    if (Array.isArray(data.slots)) state.slots = data.slots;
    if (data.summary) state.summary = data.summary;

    // Remove any selected slots that are now unavailable or deleted
    const slotMap = getSlotMap();
    Array.from(state.selectedSlotKeys).forEach((key) => {
      const slot = slotMap[key];
      if (!slot || !slot.available) state.selectedSlotKeys.delete(key);
    });

    // Ensure selectedDate still exists
    const dates = getUniqueDates();
    if (state.selectedDate !== 'ALL' && !dates.includes(state.selectedDate)) {
      state.selectedDate = 'ALL';
    }
  }

  function getSlotMap() {
    const map = {};
    state.slots.forEach((s) => { map[s.slotKey] = s; });
    return map;
  }

  function getUniqueDates() {
    const set = new Set();
    state.slots.forEach((s) => { if (s.date) set.add(s.date); });
    return Array.from(set).sort();
  }

  function getMySlotKeySet() {
    return new Set((state.mySignups || []).map((s) => s.slotKey));
  }

  function updateConnectionUI() {
    const isLive = state.mode === 'live';
    const dot = $('sync-status-dot');
    const label = $('sync-status-label');
    const previewBar = $('preview-mode-bar');
    const setupPill = $('setup-status-pill');
    const setupDesc = $('setup-status-desc');
    const resetBtn = $('btn-reset-demo');

    if (dot) dot.className = isLive ? 'sync-dot live' : 'sync-dot';
    if (label) label.textContent = isLive ? 'Live' : 'Preview';
    if (previewBar) previewBar.classList.toggle('hidden', isLive);
    if (setupPill) {
      setupPill.textContent = isLive ? 'Connected to Live Google Sheet' : 'Interactive Preview Mode';
      setupPill.classList.toggle('live', isLive);
    }
    if (setupDesc) {
      setupDesc.textContent = isLive
        ? 'Live mode is active! Volunteer signups, slot locks, swaps, cancellations, and automated Day-Before & 15-Minute reminder emails are powered directly by your Google Sheet.'
        : 'Currently saving test signups in your browser. Deploy the included Google Apps Script once to sync signups across all volunteers and send real Day-Before & 15-Minute reminder emails.';
    }
    if (resetBtn) resetBtn.classList.toggle('hidden', isLive);
  }

  // ========================================================================
  // Rendering
  // ========================================================================
  function renderAll() {
    renderHeaderAndGuide();
    renderCoverage();
    renderDateTabs();
    renderCategoryChips();
    renderSignedInBanner();
    renderShifts();
    renderSelectionTray();
    renderMyShifts();
    renderBadges();
    updateBrowserAlertButtons();
  }

  function renderHeaderAndGuide() {
    const s = state.settings;
    $('header-festival-name').textContent = s.festivalName || 'Endless Mountains Pride';
    $('header-festival-meta').textContent = `Volunteer Hub · ${s.venue || 'Mountaineer Park'}`;

    const annBar = $('announcement-bar');
    if (s.announcement && s.announcement.trim()) {
      $('announcement-text').textContent = s.announcement.trim();
      annBar.classList.remove('hidden');
    } else {
      annBar.classList.add('hidden');
    }

    if (s.checkInInstructions) {
      $('guide-checkin-text').textContent = s.checkInInstructions;
    }
    $('guide-coordinator-name').innerHTML = `<strong>${escapeHtml(s.coordinatorName || 'Endless Mountains Pride Volunteer Team')}</strong>`;

    const contactParts = [];
    if (s.coordinatorEmail) contactParts.push(`Email: <a href="mailto:${escapeHtml(s.coordinatorEmail)}">${escapeHtml(s.coordinatorEmail)}</a>`);
    if (s.coordinatorPhone) contactParts.push(`Day-of Hotline: <a href="tel:${escapeHtml(s.coordinatorPhone)}">${escapeHtml(s.coordinatorPhone)}</a>`);
    if (contactParts.length > 0) {
      $('guide-coordinator-contact').innerHTML = contactParts.join(' &nbsp;·&nbsp; ');
    }

    $('guide-venue-name').textContent = s.venue || 'Mountaineer Park';
    $('guide-venue-sub').textContent = s.locationSubtitle || 'Endless Mountains, PA';

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/edit`;
    $('setup-sheet-link').href = sheetUrl;
    $('setup-sheet-link-inline').href = sheetUrl;
    if (CONFIG.FESTIVAL_GUIDE_URL) {
      $('link-festival-guide').href = CONFIG.FESTIVAL_GUIDE_URL;
    }
  }

  function renderCoverage() {
    const { totalSpots, filledSpots, openSpots } = state.summary;
    const pct = totalSpots > 0 ? Math.round((filledSpots / totalSpots) * 100) : 0;
    $('coverage-numbers').textContent = openSpots === 1 ? '1 spot open' : `${openSpots} spots open`;
    $('coverage-bar-fill').style.width = `${pct}%`;
    $('coverage-bar-wrap').setAttribute('aria-valuenow', String(pct));
    $('coverage-meta').textContent = `${filledSpots} of ${totalSpots} volunteer spots filled (${pct}%)`;
  }

  function renderDateTabs() {
    const dates = getUniqueDates();
    const wrap = $('date-tabs');
    if (dates.length <= 1) {
      wrap.innerHTML = dates.length === 1
        ? `<div class="date-tab active">${escapeHtml(formatFriendlyDate(dates[0], true))}</div>`
        : '';
      return;
    }

    const countsByDate = {};
    state.slots.forEach((s) => {
      countsByDate[s.date] = (countsByDate[s.date] || 0) + s.remaining;
    });
    const totalOpen = state.slots.reduce((sum, s) => sum + s.remaining, 0);

    let html = `<button type="button" class="date-tab${state.selectedDate === 'ALL' ? ' active' : ''}" data-date="ALL">All Dates <span class="date-tab-count">${totalOpen}</span></button>`;
    dates.forEach((d) => {
      html += `<button type="button" class="date-tab${state.selectedDate === d ? ' active' : ''}" data-date="${escapeHtml(d)}">${escapeHtml(formatFriendlyDate(d, false))} <span class="date-tab-count">${countsByDate[d] || 0}</span></button>`;
    });
    wrap.innerHTML = html;
  }

  function renderCategoryChips() {
    const cats = ['All'];
    state.slots.forEach((s) => {
      if (s.category && !cats.includes(s.category)) cats.push(s.category);
    });
    const wrap = $('shifts-category-chips');
    wrap.innerHTML = cats.map((cat) =>
      `<button type="button" class="chip${state.categoryFilter === cat ? ' active' : ''}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
    ).join('');
  }

  function renderSignedInBanner() {
    const banner = $('signed-in-banner');
    if (state.volunteer && state.editToken) {
      $('signed-in-name').textContent = state.volunteer.name;
      $('signed-in-email').textContent = state.volunteer.email;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function getFilteredSlots() {
    const q = state.searchQuery.trim().toLowerCase();
    return state.slots.filter((s) => {
      if (state.selectedDate !== 'ALL' && s.date !== state.selectedDate) return false;
      if (state.categoryFilter !== 'All' && s.category !== state.categoryFilter) return false;
      if (state.openOnly && !s.available) return false;
      if (q) {
        const hay = `${s.location} ${s.description} ${s.category} ${s.startTime} ${s.endTime} ${s.checkInNote}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderShifts() {
    const container = $('shifts-container');
    const filtered = getFilteredSlots();
    const myKeys = getMySlotKeySet();

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🌿</div>
          <h4>No matching shifts found</h4>
          <p>Try clearing your search filter or showing full time slots.</p>
          <button type="button" class="btn btn-outline btn-sm" id="btn-clear-filters">Reset Filters</button>
        </div>
      `;
      const btn = $('btn-clear-filters');
      if (btn) {
        btn.addEventListener('click', () => {
          state.searchQuery = '';
          state.categoryFilter = 'All';
          state.openOnly = false;
          state.selectedDate = 'ALL';
          $('shifts-search').value = '';
          $('toggle-open-only').checked = false;
          renderAll();
        });
      }
      return;
    }

    // Group by Date first
    const byDate = new Map();
    filtered.forEach((slot) => {
      if (!byDate.has(slot.date)) byDate.set(slot.date, []);
      byDate.get(slot.date).push(slot);
    });

    let html = '';
    byDate.forEach((dateSlots, dateStr) => {
      html += `<div class="date-section-label">${escapeHtml(formatFriendlyDate(dateStr, true))}</div>`;

      if (state.viewMode === 'location') {
        const byStation = new Map();
        dateSlots.forEach((slot) => {
          if (!byStation.has(slot.location)) byStation.set(slot.location, []);
          byStation.get(slot.location).push(slot);
        });

        byStation.forEach((stationSlots, locationName) => {
          const first = stationSlots[0];
          const openSum = stationSlots.reduce((acc, s) => acc + s.remaining, 0);
          const openPillText = openSum === 0 ? 'All slots filled' : (openSum === 1 ? '1 spot open' : `${openSum} spots open`);

          html += `
            <article class="station-card">
              <div class="station-header">
                <div class="station-title-group">
                  <h3 class="station-title">${escapeHtml(locationName)}</h3>
                  <span class="cat-badge">${escapeHtml(first.category || 'General')}</span>
                </div>
                <span class="station-open-pill${openSum === 0 ? ' full' : ''}">${escapeHtml(openPillText)}</span>
              </div>
              <p class="station-desc">${escapeHtml(first.description)}</p>
              ${first.checkInNote ? `<p class="station-checkin"><strong>Check-in note:</strong> ${escapeHtml(first.checkInNote)}</p>` : ''}
              <div class="slots-grid">
                ${stationSlots.map((slot) => renderSlotTileHtml(slot, myKeys)).join('')}
              </div>
            </article>
          `;
        });
      } else {
        // Chronological "By Time" view
        const byStart = new Map();
        dateSlots.forEach((slot) => {
          const bucket = `${slot.startTime} – ${slot.endTime}`;
          if (!byStart.has(bucket)) byStart.set(bucket, []);
          byStart.get(bucket).push(slot);
        });

        byStart.forEach((timeSlots, rangeLabel) => {
          html += `
            <section class="time-group-card">
              <h3 class="time-group-heading">${escapeHtml(rangeLabel)}</h3>
              <div class="time-slot-rows">
                ${timeSlots.map((slot) => renderTimeRowHtml(slot, myKeys)).join('')}
              </div>
            </section>
          `;
        });
      }
    });

    container.innerHTML = html;
  }

  function renderSlotTileHtml(slot, myKeys) {
    const isMine = myKeys.has(slot.slotKey);
    const isSelected = state.selectedSlotKeys.has(slot.slotKey);
    const isFull = !slot.available;
    const isLow = slot.available && slot.remaining === 1 && slot.capacity > 1;

    let cls = 'slot-tile';
    let statusText = `${slot.remaining} of ${slot.capacity} spots left`;
    if (slot.capacity === 1 && slot.available) statusText = '1 spot open';

    if (isMine) {
      cls += ' mine';
      statusText = '✓ Your shift (tap to manage)';
    } else if (isSelected) {
      cls += ' selected';
      statusText = '✓ Selected to claim';
    } else if (isFull) {
      cls += ' full';
      statusText = 'Full · Unavailable';
    } else if (isLow) {
      cls += ' low';
      statusText = '1 spot left!';
    }

    const disabledAttr = (isFull && !isMine) ? 'disabled aria-disabled="true"' : '';
    return `
      <button type="button" class="${cls}" data-slot-key="${escapeHtml(slot.slotKey)}" ${disabledAttr}>
        <span class="slot-tile-time">${escapeHtml(slot.startTime)} – ${escapeHtml(slot.endTime)}</span>
        <span class="slot-tile-spots"><span class="spot-dot" aria-hidden="true"></span>${escapeHtml(statusText)}</span>
      </button>
    `;
  }

  function renderTimeRowHtml(slot, myKeys) {
    const isMine = myKeys.has(slot.slotKey);
    const isSelected = state.selectedSlotKeys.has(slot.slotKey);
    const isFull = !slot.available;

    let rowCls = 'time-slot-row';
    if (isSelected) rowCls += ' selected';
    if (isFull && !isMine) rowCls += ' full';

    let actionBtn = '';
    if (isMine) {
      actionBtn = `<button type="button" class="btn btn-outline btn-sm" data-slot-key="${escapeHtml(slot.slotKey)}">✓ Your Shift</button>`;
    } else if (isSelected) {
      actionBtn = `<button type="button" class="btn btn-primary btn-sm" data-slot-key="${escapeHtml(slot.slotKey)}">✓ Selected</button>`;
    } else if (isFull) {
      actionBtn = `<button type="button" class="btn btn-outline btn-sm" disabled>Full</button>`;
    } else {
      actionBtn = `<button type="button" class="btn btn-outline btn-sm" data-slot-key="${escapeHtml(slot.slotKey)}">Select (${slot.remaining} left)</button>`;
    }

    return `
      <div class="${rowCls}">
        <div class="time-slot-main">
          <div class="time-slot-title">${escapeHtml(slot.location)} <span class="cat-badge">${escapeHtml(slot.category)}</span></div>
          <div class="time-slot-sub">${escapeHtml(slot.description)}</div>
        </div>
        <div class="time-slot-meta">${actionBtn}</div>
      </div>
    `;
  }

  function renderSelectionTray() {
    const tray = $('selection-tray');
    const keys = Array.from(state.selectedSlotKeys);
    if (keys.length === 0 || state.activeTab !== 'shifts') {
      tray.classList.add('hidden');
      return;
    }

    const slotMap = getSlotMap();
    const picked = keys.map((k) => slotMap[k]).filter(Boolean);
    const totalMins = picked.reduce((sum, s) => sum + (s.endMinutes - s.startMinutes), 0);
    const hrs = Math.round((totalMins / 60) * 10) / 10;
    const locations = Array.from(new Set(picked.map((s) => s.location)));

    $('tray-count').textContent = picked.length === 1 ? '1 shift selected' : `${picked.length} shifts selected`;
    $('tray-summary').textContent = `${hrs} ${hrs === 1 ? 'hr' : 'hrs'} · ${locations.slice(0, 2).join(', ')}${locations.length > 2 ? ` +${locations.length - 2} more` : ''}`;
    $('btn-tray-signup').textContent = (state.volunteer && state.editToken) ? 'Add to My Shifts →' : 'Complete Sign-Up →';
    tray.classList.remove('hidden');
  }

  function renderMyShifts() {
    const authBox = $('my-shifts-auth');
    const activeBox = $('my-shifts-active');

    if (!state.volunteer || !state.editToken) {
      authBox.classList.remove('hidden');
      activeBox.classList.add('hidden');
      return;
    }

    authBox.classList.add('hidden');
    activeBox.classList.remove('hidden');

    const v = state.volunteer;
    const initials = (v.name || 'V').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    $('profile-avatar').textContent = initials || 'V';
    $('profile-name').textContent = v.name;
    $('profile-code').textContent = state.editToken;
    $('profile-contact').textContent = `${v.email} · ${v.phone}`;

    const notesEl = $('profile-notes');
    if (v.notes && v.notes.trim()) {
      notesEl.textContent = `Note: ${v.notes}`;
      notesEl.classList.remove('hidden');
    } else {
      notesEl.classList.add('hidden');
    }

    const shifts = state.mySignups || [];
    $('my-shifts-total-count').textContent = String(shifts.length);
    const totalMins = shifts.reduce((sum, s) => {
      const sm = s.startMinutes != null ? s.startMinutes : parseTimeToMinutes(s.startTime);
      const em = s.endMinutes != null ? s.endMinutes : parseTimeToMinutes(s.endTime);
      return sum + (sm != null && em != null ? Math.max(0, em - sm) : 0);
    }, 0);
    const totalHrs = Math.round((totalMins / 60) * 10) / 10;
    $('my-shifts-total-hours').textContent = `${totalHrs} ${totalHrs === 1 ? 'hr' : 'hrs'} total`;

    const listEl = $('my-shifts-list');
    if (shifts.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <h4>You don’t have any active shifts yet</h4>
          <p>Browse the open stations and claim a time slot that fits your day.</p>
          <button type="button" class="btn btn-primary btn-sm" id="btn-empty-browse">Browse Open Shifts</button>
        </div>
      `;
      const b = $('btn-empty-browse');
      if (b) b.addEventListener('click', () => switchTab('shifts'));
      return;
    }

    listEl.innerHTML = shifts.map((s) => {
      const statusBadge = getShiftTimingBadge(s);
      return `
        <article class="my-shift-card">
          <div class="my-shift-info">
            <div class="my-shift-meta-row">
              <span class="shift-date-pill">${escapeHtml(formatFriendlyDate(s.date, true))}</span>
              ${statusBadge}
            </div>
            <h4 class="my-shift-title">${escapeHtml(s.location)}</h4>
            <div class="my-shift-time">${escapeHtml(s.startTime)} – ${escapeHtml(s.endTime)}</div>
            <p class="my-shift-desc">${escapeHtml(s.description || '')}</p>
            ${s.checkInNote ? `<div class="my-shift-checkin"><strong>Check-in:</strong> ${escapeHtml(s.checkInNote)}</div>` : ''}
          </div>
          <div class="my-shift-actions">
            <button type="button" class="btn btn-outline btn-sm" data-swap-id="${escapeHtml(s.signupId)}">Swap / Change Time</button>
            <button type="button" class="btn btn-danger-outline btn-sm" data-cancel-id="${escapeHtml(s.signupId)}">Remove Shift</button>
          </div>
        </article>
      `;
    }).join('');
  }

  function getShiftTimingBadge(shift) {
    const startDt = parseLocalShiftDate(shift.date, shift.startTime);
    const endDt = parseLocalShiftDate(shift.date, shift.endTime);
    if (!startDt || !endDt) return '<span class="shift-status-badge">Confirmed</span>';
    const now = new Date();
    const minsUntil = (startDt.getTime() - now.getTime()) / 60000;
    if (now >= startDt && now <= endDt) {
      return '<span class="shift-status-badge soon">Happening Now</span>';
    }
    if (minsUntil > 0 && minsUntil <= 20) {
      return `<span class="shift-status-badge soon">Starts in ${Math.max(1, Math.round(minsUntil))} min!</span>`;
    }
    if (now > endDt) {
      return '<span class="shift-status-badge">Completed</span>';
    }
    return '<span class="shift-status-badge">Confirmed</span>';
  }

  function renderBadges() {
    const count = (state.mySignups || []).length;
    [$('desk-my-count'), $('mob-my-count')].forEach((badge) => {
      if (!badge) return;
      badge.textContent = String(count);
      badge.classList.toggle('hidden', count === 0);
    });
  }

  // ========================================================================
  // Interactions: Tabs, Slot Selection, Sign Up, Swap & Cancel
  // ========================================================================
  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `panel-${tabName}`);
    });
    document.querySelectorAll('.nav-tab, .mobile-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    renderSelectionTray();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleSlotSelection(slotKey) {
    const myKeys = getMySlotKeySet();
    if (myKeys.has(slotKey)) {
      switchTab('my-shifts');
      showToast('You are signed up for this shift — you can swap or remove it here.');
      return;
    }

    const slotMap = getSlotMap();
    const slot = slotMap[slotKey];
    if (!slot || !slot.available) return;

    if (state.selectedSlotKeys.has(slotKey)) {
      state.selectedSlotKeys.delete(slotKey);
      renderShifts();
      renderSelectionTray();
      return;
    }

    // Check overlap with currently selected slots & existing shifts
    const alreadySelected = Array.from(state.selectedSlotKeys).map((k) => slotMap[k]).filter(Boolean);
    const conflict = findOverlapMessage([slot], alreadySelected.concat(state.mySignups || []));
    if (conflict) {
      showToast(conflict, 'error');
      return;
    }

    state.selectedSlotKeys.add(slotKey);
    renderShifts();
    renderSelectionTray();
  }

  function openSignupModal() {
    const keys = Array.from(state.selectedSlotKeys);
    if (keys.length === 0) return;

    $('signup-step-form').classList.remove('hidden');
    $('signup-step-success').classList.add('hidden');
    $('signup-error').classList.add('hidden');
    $('signup-modal-title').textContent = (state.volunteer && state.editToken)
      ? 'Add Shifts to Your Schedule'
      : 'Complete Volunteer Sign-Up';

    if (state.volunteer) {
      $('vol-name').value = state.volunteer.name || '';
      $('vol-email').value = state.volunteer.email || '';
      $('vol-phone').value = state.volunteer.phone || '';
      $('vol-notes').value = state.volunteer.notes || '';
    }

    renderSignupModalReview();
    openModal('signup-modal');
  }

  function renderSignupModalReview() {
    const slotMap = getSlotMap();
    const picked = Array.from(state.selectedSlotKeys).map((k) => slotMap[k]).filter(Boolean);
    const wrap = $('signup-slots-review');
    wrap.innerHTML = picked.map((s) => `
      <div class="review-item">
        <div>
          <strong>${escapeHtml(s.location)}</strong>
          <span>${escapeHtml(formatFriendlyDate(s.date, false))} · ${escapeHtml(s.startTime)} – ${escapeHtml(s.endTime)} (${escapeHtml(formatDurationHours(s.startMinutes, s.endMinutes))})</span>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" data-remove-picked="${escapeHtml(s.slotKey)}">Remove</button>
      </div>
    `).join('');
  }

  async function handleSignupSubmit(e) {
    e.preventDefault();
    const errEl = $('signup-error');
    errEl.classList.add('hidden');

    const name = $('vol-name').value.trim();
    const email = $('vol-email').value.trim().toLowerCase();
    const phone = $('vol-phone').value.trim();
    const notes = $('vol-notes').value.trim();
    const slotKeys = Array.from(state.selectedSlotKeys);

    if (slotKeys.length === 0) {
      closeModal('signup-modal');
      return;
    }
    if (name.length < 2) {
      errEl.textContent = 'Please enter your full name.';
      errEl.classList.remove('hidden');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = 'Please enter a valid email address.';
      errEl.classList.remove('hidden');
      return;
    }
    if (phone.replace(/\D/g, '').length < 7) {
      errEl.textContent = 'Please enter a valid phone number so coordinators can reach you on festival day.';
      errEl.classList.remove('hidden');
      return;
    }

    const submitBtn = $('btn-submit-signup');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Reserving spots…';

    try {
      const sameLoggedInVolunteer = state.volunteer && state.editToken && state.volunteer.email.toLowerCase() === email;
      let res;
      if (sameLoggedInVolunteer) {
        res = await apiRequest('updateSignups', {
          email,
          token: state.editToken,
          addSlotKeys: slotKeys,
          removeSignupIds: [],
          name,
          phone,
          notes
        });
      } else {
        res = await apiRequest('signup', { name, email, phone, notes, slotKeys });
      }

      if (!res || !res.ok) {
        if (res && res.schedule) applyScheduleData(res.schedule);
        renderAll();
        errEl.textContent = (res && res.error) || 'Could not complete sign-up. Please try again.';
        errEl.classList.remove('hidden');
        return;
      }

      state.volunteer = res.volunteer;
      state.editToken = res.editToken;
      state.mySignups = res.mySignups || [];
      state.selectedSlotKeys.clear();
      if (res.schedule) applyScheduleData(res.schedule);
      saveSession();
      renderAll();

      // Show Confirmation Screen
      $('signup-modal-title').textContent = 'Shift Confirmed!';
      $('signup-step-form').classList.add('hidden');
      $('signup-step-success').classList.remove('hidden');
      $('success-manage-code').textContent = state.editToken;
      $('success-message').textContent = state.mode === 'live'
        ? `We emailed your confirmation & calendar invite to ${state.volunteer.email}. Your chosen slot${slotKeys.length > 1 ? 's are' : ' is'} now held for you!`
        : `Preview Mode: Your slot${slotKeys.length > 1 ? 's are' : ' is'} now reserved and marked unavailable to others. Save your Manage Code below to test swapping or canceling!`;
    } catch (err) {
      errEl.textContent = 'Network error while reserving your shift. Please try again.';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm Volunteer Sign-Up';
    }
  }

  async function handleLookupSubmit(e) {
    e.preventDefault();
    const errEl = $('lookup-error');
    errEl.classList.add('hidden');

    const email = $('lookup-email').value.trim().toLowerCase();
    const token = $('lookup-code').value.trim().toUpperCase();
    if (!email || !token) {
      errEl.textContent = 'Please enter both your email address and 6-character Manage Code.';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = $('btn-lookup-submit');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const res = await apiRequest('lookup', { email, token });
      if (!res || !res.ok) {
        errEl.textContent = (res && res.error) || 'Could not find your shifts.';
        errEl.classList.remove('hidden');
        return;
      }
      state.volunteer = res.volunteer;
      state.editToken = res.editToken;
      state.mySignups = res.mySignups || [];
      saveSession();
      renderAll();
      showToast(`Welcome back, ${state.volunteer.name}!`);
    } catch {
      errEl.textContent = 'Network error. Please try again.';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Access My Shifts';
    }
  }

  async function handleRecoverSubmit(e) {
    e.preventDefault();
    const fb = $('recover-feedback');
    fb.classList.add('hidden');
    const email = $('recover-email').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fb.textContent = 'Please enter a valid email address.';
      fb.classList.remove('hidden');
      return;
    }
    const btn = $('btn-recover-submit');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await apiRequest('sendAccessLink', { email });
      fb.textContent = (res && (res.message || res.error)) || 'Check your inbox!';
      fb.classList.remove('hidden');
    } catch {
      fb.textContent = 'Network error. Please try again.';
      fb.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Email Me My Link';
    }
  }

  async function handleCancelShift(signupId) {
    const shift = (state.mySignups || []).find((s) => s.signupId === signupId);
    if (!shift) return;
    const confirmed = window.confirm(
      `Remove your shift at ${shift.location} (${formatFriendlyDate(shift.date, false)}, ${shift.startTime} – ${shift.endTime})?\n\nThis spot will immediately become open again for another volunteer.`
    );
    if (!confirmed) return;

    try {
      const res = await apiRequest('cancelSignup', {
        email: state.volunteer.email,
        token: state.editToken,
        signupId
      });
      if (!res || !res.ok) {
        showToast((res && res.error) || 'Could not remove shift.', 'error');
        return;
      }
      state.mySignups = res.mySignups || [];
      if (res.schedule) applyScheduleData(res.schedule);
      saveSession();
      renderAll();
      showToast('Shift removed — that slot is now open again for others.');
    } catch {
      showToast('Network error while removing shift.', 'error');
    }
  }

  function openSwapModal(signupId) {
    const shift = (state.mySignups || []).find((s) => s.signupId === signupId);
    if (!shift) return;
    state.swapTargetSignup = shift;
    state.swapSearch = '';
    $('swap-search').value = '';
    $('swap-error').classList.add('hidden');
    $('swap-current-summary').innerHTML = `<strong>${escapeHtml(shift.location)}</strong> · ${escapeHtml(formatFriendlyDate(shift.date, false))} · ${escapeHtml(shift.startTime)} – ${escapeHtml(shift.endTime)}`;
    renderSwapOptions();
    openModal('swap-modal');
  }

  function renderSwapOptions() {
    const current = state.swapTargetSignup;
    if (!current) return;

    const otherMine = (state.mySignups || []).filter((s) => s.signupId !== current.signupId);
    const otherMineKeys = new Set(otherMine.map((s) => s.slotKey));
    const q = state.swapSearch.trim().toLowerCase();

    const candidates = state.slots
      .filter((slot) => {
        if (!slot.available) return false;
        if (slot.slotKey === current.slotKey) return false;
        if (otherMineKeys.has(slot.slotKey)) return false;
        if (findOverlapMessage([slot], otherMine)) return false;
        if (q) {
          const hay = `${slot.location} ${slot.startTime} ${slot.endTime} ${slot.date} ${slot.category}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Prioritize same station first!
        const aSame = a.location === current.location ? 0 : 1;
        const bSame = b.location === current.location ? 0 : 1;
        if (aSame !== bSame) return aSame - bSame;
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.startMinutes - b.startMinutes;
      });

    const wrap = $('swap-options-list');
    if (candidates.length === 0) {
      wrap.innerHTML = `<div class="empty-state"><p>No other open, non-overlapping slots match your filter.</p></div>`;
      return;
    }

    wrap.innerHTML = candidates.map((slot) => {
      const same = slot.location === current.location;
      return `
        <div class="swap-option${same ? ' same-station' : ''}">
          <div class="swap-option-info">
            <strong>${escapeHtml(slot.location)} ${same ? '<span class="cat-badge">Same Station</span>' : ''}</strong>
            <span>${escapeHtml(formatFriendlyDate(slot.date, false))} · ${escapeHtml(slot.startTime)} – ${escapeHtml(slot.endTime)} · ${slot.remaining} ${slot.remaining === 1 ? 'spot' : 'spots'} open</span>
          </div>
          <button type="button" class="btn btn-primary btn-sm" data-confirm-swap="${escapeHtml(slot.slotKey)}">Switch to This</button>
        </div>
      `;
    }).join('');
  }

  async function executeSwap(newSlotKey) {
    const current = state.swapTargetSignup;
    if (!current) return;
    const errEl = $('swap-error');
    errEl.classList.add('hidden');

    try {
      const res = await apiRequest('updateSignups', {
        email: state.volunteer.email,
        token: state.editToken,
        addSlotKeys: [newSlotKey],
        removeSignupIds: [current.signupId]
      });
      if (!res || !res.ok) {
        if (res && res.schedule) applyScheduleData(res.schedule);
        renderAll();
        errEl.textContent = (res && res.error) || 'Could not swap shifts.';
        errEl.classList.remove('hidden');
        return;
      }
      state.mySignups = res.mySignups || [];
      if (res.schedule) applyScheduleData(res.schedule);
      saveSession();
      closeModal('swap-modal');
      renderAll();
      showToast('Shift swapped! Your old spot is now open again for others.');
    } catch {
      errEl.textContent = 'Network error while swapping shift.';
      errEl.classList.remove('hidden');
    }
  }

  async function handleProfileSave(e) {
    e.preventDefault();
    const errEl = $('profile-error');
    errEl.classList.add('hidden');

    const name = $('edit-vol-name').value.trim();
    const phone = $('edit-vol-phone').value.trim();
    const notes = $('edit-vol-notes').value.trim();
    if (name.length < 2 || phone.replace(/\D/g, '').length < 7) {
      errEl.textContent = 'Please provide a valid name and phone number.';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = $('btn-save-profile');
    btn.disabled = true;
    try {
      const res = await apiRequest('updateProfile', {
        email: state.volunteer.email,
        token: state.editToken,
        name,
        phone,
        notes
      });
      if (!res || !res.ok) {
        errEl.textContent = (res && res.error) || 'Could not update profile.';
        errEl.classList.remove('hidden');
        return;
      }
      state.volunteer = res.volunteer;
      if (res.mySignups) state.mySignups = res.mySignups;
      saveSession();
      closeModal('profile-modal');
      renderAll();
      showToast('Contact information updated!');
    } catch {
      errEl.textContent = 'Network error while updating profile.';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  }

  // ========================================================================
  // 15-Minute Browser Notifications, Chime & .ics Calendar Download
  // ========================================================================
  function parseLocalShiftDate(isoDate, timeStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '')) return null;
    const mins = parseTimeToMinutes(timeStr);
    if (mins === null) return null;
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60, 0, 0);
  }

  function playGentleChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      [587.33, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.16;
        gain.gain.setValueAtTime(0.001, t);
        gain.gain.exponentialRampToValueAtTime(0.14, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.45);
      });
    } catch {
      // audio blocked by autoplay policy
    }
  }

  function showReminderBanner(title, body) {
    $('reminder-banner-title').textContent = title;
    $('reminder-banner-body').textContent = body;
    $('reminder-banner').classList.remove('hidden');
    playGentleChime();
  }

  async function enableBrowserAlerts() {
    if (!('Notification' in window)) {
      state.alertsEnabled = true;
      localStorage.setItem(STORAGE_KEYS.alertsEnabled, '1');
      updateBrowserAlertButtons();
      showToast('In-app 15-minute banners enabled! Download the .ics file for lock-screen phone alarms.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      state.alertsEnabled = true;
      localStorage.setItem(STORAGE_KEYS.alertsEnabled, '1');
      updateBrowserAlertButtons();
      showToast('15-minute browser shift alerts enabled!');
    } else {
      state.alertsEnabled = true;
      localStorage.setItem(STORAGE_KEYS.alertsEnabled, '1');
      updateBrowserAlertButtons();
      showToast('Browser popups blocked — in-app 15-minute banners are still active, or add shifts to your Phone Calendar (.ics).');
    }
  }

  function updateBrowserAlertButtons() {
    const enabled = state.alertsEnabled;
    const lbl = $('browser-alert-label');
    if (lbl) lbl.textContent = enabled ? '15-Min Alerts Active ✓' : 'Enable 15-Min Browser Alerts';
    const sucBtn = $('btn-success-notify');
    if (sucBtn) sucBtn.textContent = enabled ? '🔔 15-Min Browser Alerts Active ✓' : '🔔 Enable 15-Min Browser Alerts';
  }

  function fireShiftNotification(shift, minsUntil, isTest) {
    const title = isTest
      ? `Test 15-Min Alert: ${shift.location}`
      : `Shift starts in ${Math.max(1, Math.round(minsUntil))} minutes!`;
    const body = `${shift.location} (${shift.startTime} – ${shift.endTime})${shift.checkInNote ? ' · ' + shift.checkInNote : ''}`;

    showReminderBanner(title, body);

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
          navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification(title, {
              body,
              icon: './assets/icon-192.png',
              badge: './assets/icon-192.png',
              tag: `emp-shift-${shift.signupId || 'test'}`
            });
          }).catch(() => new Notification(title, { body, icon: './assets/icon-192.png' }));
        } else {
          new Notification(title, { body, icon: './assets/icon-192.png' });
        }
      } catch {
        // banner already visible
      }
    }
  }

  function checkUpcoming15MinReminders() {
    const shifts = state.mySignups || [];
    if (shifts.length === 0) return;
    const now = Date.now();
    shifts.forEach((shift) => {
      const startDt = parseLocalShiftDate(shift.date, shift.startTime);
      if (!startDt) return;
      const minsUntil = (startDt.getTime() - now) / 60000;
      const key = `${shift.signupId}|${shift.date}|${shift.startTime}`;
      if (minsUntil > 0 && minsUntil <= 15.5 && !state.firedAlerts.has(key)) {
        state.firedAlerts.add(key);
        try {
          localStorage.setItem(STORAGE_KEYS.firedAlerts, JSON.stringify(Array.from(state.firedAlerts)));
        } catch {
          // ignore
        }
        fireShiftNotification(shift, minsUntil, false);
      }
    });
  }

  function downloadMyShiftsIcs() {
    const shifts = state.mySignups || [];
    if (shifts.length === 0) {
      showToast('Sign up for at least one shift first to export your calendar.', 'error');
      return;
    }

    const festivalName = state.settings.festivalName || 'Endless Mountains Pride';
    const venue = state.settings.venue || 'Mountaineer Park';
    const tz = state.settings.timezone || 'America/New_York';
    const nowUtc = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Endless Mountains Pride//Volunteer Hub//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc(festivalName + ' Volunteer Shifts')}`,
      `X-WR-TIMEZONE:${tz}`
    ];

    shifts.forEach((s, i) => {
      const sm = parseTimeToMinutes(s.startTime);
      const em = parseTimeToMinutes(s.endTime);
      if (sm === null || em === null || !s.date) return;
      const compactDate = s.date.replace(/-/g, '');
      const fmtT = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}00`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${s.signupId || ('emp-' + i)}@endlessmountainspride.org`,
        `DTSTAMP:${nowUtc}`,
        `DTSTART;TZID=${tz}:${compactDate}T${fmtT(sm)}`,
        `DTEND;TZID=${tz}:${compactDate}T${fmtT(em)}`,
        `SUMMARY:${esc('Volunteer: ' + s.location + ' (' + festivalName + ')')}`,
        `LOCATION:${esc(s.location + ', ' + venue)}`,
        `DESCRIPTION:${esc((s.description || '') + (s.checkInNote ? '\n\nCheck-in: ' + s.checkInNote : ''))}`,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT15M',
        `DESCRIPTION:${esc('Volunteer shift starts in 15 minutes at ' + s.location)}`,
        'END:VALARM',
        'END:VEVENT'
      );
    });

    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'endless-mountains-pride-volunteer-shifts.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Calendar file (.ics) downloaded with 15-minute phone reminders!');
  }

  // ========================================================================
  // Organizer Setup Modal (Connect Live Apps Script URL)
  // ========================================================================
  async function handleSaveScriptUrl(e) {
    e.preventDefault();
    const fb = $('setup-url-feedback');
    fb.classList.add('hidden');
    const raw = $('setup-script-url').value.trim();

    if (!raw) {
      localStorage.removeItem(STORAGE_KEYS.customScriptUrl);
      state.scriptUrl = (CONFIG.APPS_SCRIPT_URL || '').trim();
      state.mode = state.scriptUrl ? 'live' : 'preview';
      await syncSchedule(true);
      fb.textContent = state.mode === 'live'
        ? 'Reverted to URL in config.js.'
        : 'Cleared custom URL — running in Interactive Preview Mode.';
      fb.classList.remove('hidden');
      return;
    }

    if (!raw.startsWith('https://script.google.com/')) {
      fb.textContent = 'Please paste a valid Google Apps Script Web App URL starting with https://script.google.com/...';
      fb.classList.remove('hidden');
      return;
    }

    const btn = $('btn-save-script-url');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    try {
      const pingUrl = `${raw}${raw.includes('?') ? '&' : '?'}action=ping&_t=${Date.now()}`;
      const res = await fetch(pingUrl);
      const data = await res.json();
      if (!data || !data.ok) throw new Error('Unexpected response');

      localStorage.setItem(STORAGE_KEYS.customScriptUrl, raw);
      state.scriptUrl = raw;
      state.mode = 'live';
      clearSession(); // Clear any preview-mode local session
      await syncSchedule(true);
      fb.textContent = `Connected to "${data.festivalName || 'Volunteer Schedule'}"! Remember to also paste this URL into config.js so all volunteers connect automatically.`;
      fb.classList.remove('hidden');
      showToast('Connected to live Google Sheet!');
    } catch {
      fb.textContent = 'Could not connect to that URL. Double-check that your Web App deployment has "Who has access: Anyone" and ends in /exec.';
      fb.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }

  // ========================================================================
  // Event Binding & Boot
  // ========================================================================
  function bindEvents() {
    // Nav tabs (desktop + mobile)
    document.querySelectorAll('.nav-tab, .mobile-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    $('brand-home').addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('shifts');
    });

    // Header actions
    $('btn-sync-sheet').addEventListener('click', () => syncSchedule(false));
    $('btn-open-setup').addEventListener('click', () => {
      $('setup-script-url').value = state.scriptUrl || '';
      $('setup-url-feedback').classList.add('hidden');
      openModal('setup-modal');
    });
    $('btn-preview-setup').addEventListener('click', () => {
      $('setup-script-url').value = state.scriptUrl || '';
      $('setup-url-feedback').classList.add('hidden');
      openModal('setup-modal');
    });

    // Date tabs, view switcher, search & category chips
    $('date-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.date-tab');
      if (!btn || !btn.dataset.date) return;
      state.selectedDate = btn.dataset.date;
      renderDateTabs();
      renderShifts();
    });

    $('view-mode-segment').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn || !btn.dataset.view) return;
      state.viewMode = btn.dataset.view;
      document.querySelectorAll('#view-mode-segment .seg-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      renderShifts();
    });

    $('shifts-search').addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderShifts();
    });

    $('toggle-open-only').addEventListener('change', (e) => {
      state.openOnly = e.target.checked;
      renderShifts();
    });

    $('shifts-category-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || !chip.dataset.cat) return;
      state.categoryFilter = chip.dataset.cat;
      renderCategoryChips();
      renderShifts();
    });

    // Slot clicks (delegated)
    $('shifts-container').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-slot-key]');
      if (!btn || btn.disabled) return;
      toggleSlotSelection(btn.dataset.slotKey);
    });

    // Selection tray
    $('btn-tray-clear').addEventListener('click', () => {
      state.selectedSlotKeys.clear();
      renderShifts();
      renderSelectionTray();
    });
    $('btn-tray-signup').addEventListener('click', openSignupModal);
    $('btn-banner-my-shifts').addEventListener('click', () => switchTab('my-shifts'));

    // Sign-Up Modal
    $('signup-slots-review').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove-picked]');
      if (!rm) return;
      state.selectedSlotKeys.delete(rm.dataset.removePicked);
      renderShifts();
      renderSelectionTray();
      if (state.selectedSlotKeys.size === 0) {
        closeModal('signup-modal');
      } else {
        renderSignupModalReview();
      }
    });
    $('signup-form').addEventListener('submit', handleSignupSubmit);
    $('btn-success-copy-code').addEventListener('click', () => copyText(state.editToken, 'Manage Code copied!'));
    $('btn-success-ics').addEventListener('click', downloadMyShiftsIcs);
    $('btn-success-notify').addEventListener('click', enableBrowserAlerts);
    $('btn-success-my-shifts').addEventListener('click', () => {
      closeModal('signup-modal');
      switchTab('my-shifts');
    });

    // My Shifts Auth & Dashboard
    $('lookup-form').addEventListener('submit', handleLookupSubmit);
    $('recover-form').addEventListener('submit', handleRecoverSubmit);
    $('btn-go-browse-shifts').addEventListener('click', () => switchTab('shifts'));
    $('btn-copy-code').addEventListener('click', () => copyText(state.editToken, 'Manage Code copied!'));
    $('btn-add-more-shifts').addEventListener('click', () => switchTab('shifts'));
    $('btn-switch-volunteer').addEventListener('click', () => {
      clearSession();
      state.selectedSlotKeys.clear();
      renderAll();
      showToast('Signed out on this device. You can sign in as another volunteer.');
    });
    $('btn-edit-profile').addEventListener('click', () => {
      if (!state.volunteer) return;
      $('edit-vol-name').value = state.volunteer.name || '';
      $('edit-vol-phone').value = state.volunteer.phone || '';
      $('edit-vol-notes').value = state.volunteer.notes || '';
      $('profile-error').classList.add('hidden');
      openModal('profile-modal');
    });
    $('profile-form').addEventListener('submit', handleProfileSave);

    // My Shifts cards: Swap / Cancel (delegated)
    $('my-shifts-list').addEventListener('click', (e) => {
      const swapBtn = e.target.closest('[data-swap-id]');
      if (swapBtn) {
        openSwapModal(swapBtn.dataset.swapId);
        return;
      }
      const cancelBtn = e.target.closest('[data-cancel-id]');
      if (cancelBtn) {
        handleCancelShift(cancelBtn.dataset.cancelId);
      }
    });

    // Swap Modal
    $('swap-search').addEventListener('input', (e) => {
      state.swapSearch = e.target.value;
      renderSwapOptions();
    });
    $('swap-options-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-confirm-swap]');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'Switching…';
      executeSwap(btn.dataset.confirmSwap);
    });

    // Reminder Toolkit & Banner
    $('btn-download-ics').addEventListener('click', downloadMyShiftsIcs);
    $('btn-enable-browser-alerts').addEventListener('click', enableBrowserAlerts);
    $('btn-test-15min-alert').addEventListener('click', () => {
      const sample = (state.mySignups && state.mySignups[0]) || {
        signupId: 'test',
        location: 'Main Entrance',
        startTime: '10:00 AM',
        endTime: '12:00 PM',
        checkInNote: 'Check in at emPRIDE & Drinks tent.'
      };
      fireShiftNotification(sample, 15, true);
    });
    $('reminder-banner-view').addEventListener('click', () => {
      $('reminder-banner').classList.add('hidden');
      switchTab('my-shifts');
    });
    $('reminder-banner-close').addEventListener('click', () => {
      $('reminder-banner').classList.add('hidden');
    });

    // Setup Modal
    $('setup-url-form').addEventListener('submit', handleSaveScriptUrl);
    $('btn-reset-demo').addEventListener('click', async () => {
      if (!window.confirm('Clear all local preview signups in this browser?')) return;
      localStorage.removeItem(STORAGE_KEYS.demoSignups);
      clearSession();
      state.selectedSlotKeys.clear();
      await syncSchedule(true);
      closeModal('setup-modal');
      showToast('Preview signups reset.');
    });

    // Modal closing (buttons, backdrop, Escape key)
    document.querySelectorAll('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal(backdrop.id);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach((m) => closeModal(m.id));
      }
    });

    // Service Worker notification click message
    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'OPEN_MY_SHIFTS') {
          switchTab('my-shifts');
        }
      });
    }
  }

  function copyText(text, successMsg) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(successMsg)).catch(() => showToast(`Code: ${text}`));
    } else {
      showToast(`Code: ${text}`);
    }
  }

  async function init() {
    state.scriptUrl = resolveScriptUrl();
    state.mode = state.scriptUrl ? 'live' : 'preview';
    state.alertsEnabled = localStorage.getItem(STORAGE_KEYS.alertsEnabled) === '1';

    try {
      const fired = JSON.parse(localStorage.getItem(STORAGE_KEYS.firedAlerts) || '[]');
      state.firedAlerts = new Set(Array.isArray(fired) ? fired : []);
    } catch {
      state.firedAlerts = new Set();
    }

    loadSession();
    bindEvents();

    // Check for magic link ?token=XXXXXX
    const params = new URLSearchParams(window.location.search);
    const urlToken = (params.get('token') || '').trim().toUpperCase();
    if (urlToken) {
      state.editToken = urlToken;
      // Clean token from URL bar after capturing it
      const cleanUrl = window.location.pathname + (window.location.hash || '#my-shifts');
      window.history.replaceState({}, '', cleanUrl);
    }

    await syncSchedule(true);

    // If opened via magic link or #my-shifts hash
    if (urlToken || window.location.hash === '#my-shifts') {
      switchTab('my-shifts');
      if (urlToken && state.volunteer) {
        showToast(`Loaded shifts for ${state.volunteer.name}`);
      }
    } else if (window.location.hash === '#guide') {
      switchTab('guide');
    }

    // Start 15-minute shift reminder loop (runs every 20 seconds)
    checkUpcoming15MinReminders();
    state.reminderIntervalId = setInterval(checkUpcoming15MinReminders, 20000);

    // Register PWA Service Worker
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
