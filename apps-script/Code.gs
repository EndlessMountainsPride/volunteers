/**
 * ============================================================================
 * Endless Mountains Pride — Volunteer Hub Backend (Google Apps Script)
 * ============================================================================
 *
 * Attach this script to your "Endless Mountains Pride - Volunteer Schedule"
 * Google Sheet via: Extensions → Apps Script → paste this entire file → Save.
 *
 * Then deploy once:
 *   Deploy → New deployment → Web app
 *     - Execute as: Me (your Google account — sends emails on your behalf)
 *     - Who has access: Anyone
 *   Copy the Web App URL (ending in /exec) into config.js → APPS_SCRIPT_URL.
 *
 * Finally, reload your Google Sheet and click the top menu:
 *   "🏳️‍🌈 Volunteer Hub" → "✅ Enable Automated Reminders"
 * to turn on Day-Before emails and 15-Minute-Before shift alert emails!
 */

const TAB_SHIFTS = 'Shifts';
const TAB_SIGNUPS = 'Signups';
const TAB_SETTINGS = 'Settings';

const SIGNUP_HEADERS = [
  'Signup ID',
  'Slot Key',
  'Date',
  'Location',
  'Start Time',
  'End Time',
  'Description',
  'Volunteer Name',
  'Email',
  'Phone',
  'Edit Token',
  'Status',
  'Signed Up At',
  'Day-Before Reminder Sent',
  '15-Min Reminder Sent',
  'Notes'
];

// ============================================================================
// Custom Google Sheets Menu (for Festival Organizers)
// ============================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏳️‍🌈 Volunteer Hub')
    .addItem('✅ Enable Automated Reminders (Day-Before + 15-Min)', 'setupReminderTriggers')
    .addItem('🛑 Pause Automated Reminders', 'removeReminderTriggers')
    .addItem('📊 Check Reminder Trigger Status', 'showTriggerStatus')
    .addSeparator()
    .addItem('📧 Send Test Reminder Email to Me', 'sendTestReminderToOrganizer')
    .addItem('🔄 Run Reminder Check Now', 'runAllReminderChecksNow')
    .addToUi();
}

function setupReminderTriggers() {
  removeReminderTriggers(true);

  // Check every hour whether it's time to send Day-Before reminder emails
  ScriptApp.newTrigger('sendDayBeforeReminders')
    .timeBased()
    .everyHours(1)
    .create();

  // Check every 5 minutes for shifts starting in ~15 minutes
  ScriptApp.newTrigger('sendFifteenMinuteReminders')
    .timeBased()
    .everyMinutes(5)
    .create();

  try {
    SpreadsheetApp.getUi().alert(
      'Automated Reminders Enabled!',
      'Two background schedules are now active:\n\n' +
        '1. Day-Before Reminder Emails (checks hourly; sends at the hour set in the Settings tab)\n' +
        '2. 15-Minute Shift Alerts (checks every 5 minutes and emails volunteers 15 minutes before their shift starts)\n\n' +
        'You can pause them anytime from the Volunteer Hub menu.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    Logger.log('Automated reminders enabled.');
  }
}

function removeReminderTriggers(silent) {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (trigger) {
    const fn = trigger.getHandlerFunction();
    if (fn === 'sendDayBeforeReminders' || fn === 'sendFifteenMinuteReminders') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  if (!silent) {
    try {
      SpreadsheetApp.getUi().alert(
        'Reminders Paused',
        'Automated Day-Before and 15-Minute reminder triggers have been paused.',
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (e) {
      Logger.log('Reminders paused.');
    }
  }
}

function showTriggerStatus() {
  const triggers = ScriptApp.getProjectTriggers();
  const hasDayBefore = triggers.some(function (t) {
    return t.getHandlerFunction() === 'sendDayBeforeReminders';
  });
  const has15Min = triggers.some(function (t) {
    return t.getHandlerFunction() === 'sendFifteenMinuteReminders';
  });
  const remainingQuota = MailApp.getRemainingDailyQuota();

  SpreadsheetApp.getUi().alert(
    'Volunteer Hub Reminder Status',
    'Day-Before Reminder Trigger: ' + (hasDayBefore ? 'ACTIVE ✅' : 'OFF ⏸️') + '\n' +
      '15-Minute Alert Trigger: ' + (has15Min ? 'ACTIVE ✅' : 'OFF ⏸️') + '\n' +
      'Remaining Gmail Daily Send Quota: ' + remainingQuota + ' emails today',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function runAllReminderChecksNow() {
  const dayBeforeCount = sendDayBeforeReminders();
  const fifteenMinCount = sendFifteenMinuteReminders();
  try {
    SpreadsheetApp.getUi().alert(
      'Reminder Check Complete',
      'Day-before reminder emails sent: ' + dayBeforeCount + '\n' +
        '15-minute alert emails sent: ' + fifteenMinCount,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    Logger.log('Day-before sent: ' + dayBeforeCount + ', 15-min sent: ' + fifteenMinCount);
  }
}

function sendTestReminderToOrganizer() {
  const settings = loadSettings_();
  const me = Session.getActiveUser().getEmail() || settings['Coordinator Email'];
  if (!me) {
    SpreadsheetApp.getUi().alert('Could not detect your email address. Add Coordinator Email in the Settings tab.');
    return;
  }
  const slots = buildAllSlots_(settings);
  const sampleSlot = slots.length > 0 ? slots[0] : {
    date: '2027-06-12',
    location: 'Main Entrance',
    startTime: '10:00 AM',
    endTime: '12:00 PM',
    description: 'Welcoming attendees and handing out wristbands.',
    checkInNote: settings['Check-In Instructions'] || ''
  };

  sendEmail_(
    me,
    '[Test] ' + (settings['Festival Name'] || 'Endless Mountains Pride') + ' — Volunteer Reminder Preview',
    buildDayBeforeEmailHtml_('Festival Organizer', [sampleSlot], 'DEMO99', settings),
    'This is a test volunteer reminder from your Endless Mountains Pride Volunteer Hub.',
    settings,
    buildIcsAttachment_([sampleSlot], settings)
  );

  SpreadsheetApp.getUi().alert('Test Email Sent!', 'Check your inbox at ' + me + ' for the preview email & calendar invite (.ics).', SpreadsheetApp.getUi().ButtonSet.OK);
}

// ============================================================================
// HTTP Web App Entrypoints (CORS-friendly GET + simple text/plain POST)
// ============================================================================

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = (params.action || 'schedule').toLowerCase();

    if (action === 'ping') {
      const settings = loadSettings_();
      return jsonResponse_({
        ok: true,
        status: 'connected',
        festivalName: settings['Festival Name'] || 'Endless Mountains Pride',
        serverTime: new Date().toISOString()
      });
    }

    if (action === 'schedule') {
      return jsonResponse_(getSchedulePayload_());
    }

    if (action === 'lookup') {
      return jsonResponse_(handleLookup_({
        email: params.email || '',
        token: params.token || ''
      }));
    }

    return jsonResponse_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message || String(err) });
  }
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const body = JSON.parse(raw);
    const action = String(body.action || '').toLowerCase();

    if (action === 'signup') {
      return jsonResponse_(handleSignup_(body));
    }
    if (action === 'lookup') {
      return jsonResponse_(handleLookup_(body));
    }
    if (action === 'updatesignups') {
      return jsonResponse_(handleUpdateSignups_(body));
    }
    if (action === 'cancelsignup') {
      return jsonResponse_(handleCancelSignup_(body));
    }
    if (action === 'sendaccesslink') {
      return jsonResponse_(handleSendAccessLink_(body));
    }
    if (action === 'updateprofile') {
      return jsonResponse_(handleUpdateProfile_(body));
    }

    return jsonResponse_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message || String(err) });
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// Core Business Actions (with LockService Atomic Concurrency Control)
// ============================================================================

function getSchedulePayload_() {
  const settings = loadSettings_();
  const slots = buildAllSlots_(settings);
  const signups = loadSignups_();
  const enriched = attachAvailability_(slots, signups);

  const totalSpots = enriched.reduce(function (sum, s) { return sum + s.capacity; }, 0);
  const filledSpots = enriched.reduce(function (sum, s) { return sum + s.filled; }, 0);

  return {
    ok: true,
    settings: sanitizePublicSettings_(settings),
    slots: enriched,
    summary: {
      totalSlots: enriched.length,
      totalSpots: totalSpots,
      filledSpots: filledSpots,
      openSpots: Math.max(0, totalSpots - filledSpots)
    },
    serverTime: new Date().toISOString()
  };
}

function handleSignup_(body) {
  const name = cleanStr_(body.name);
  const email = normalizeEmail_(body.email);
  const phone = cleanStr_(body.phone);
  const notes = cleanStr_(body.notes);
  const slotKeys = Array.isArray(body.slotKeys) ? uniqueStrings_(body.slotKeys) : [];

  if (!name || name.length < 2) {
    return { ok: false, error: 'Please enter your full name.' };
  }
  if (!isValidEmail_(email)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  if (!phone || phone.replace(/\D/g, '').length < 7) {
    return { ok: false, error: 'Please enter a valid phone number.' };
  }
  if (slotKeys.length === 0) {
    return { ok: false, error: 'Please select at least one shift slot.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, error: 'The signup sheet is busy right now. Please tap Sign Up again in a second.' };
  }

  try {
    const settings = loadSettings_();
    const allSlots = buildAllSlots_(settings);
    const existingSignups = loadSignups_();
    const enriched = attachAvailability_(allSlots, existingSignups);
    const slotMap = indexBy_(enriched, 'slotKey');

    const myExisting = existingSignups.filter(function (s) {
      return s.status === 'Confirmed' && normalizeEmail_(s.email) === email;
    });

    // Reuse existing edit token for this volunteer email (even across past/cancelled rows)
    const editToken = findOrCreateToken_(existingSignups, email);

    const requestedSlots = [];
    const unavailableSlots = [];

    for (let i = 0; i < slotKeys.length; i++) {
      const key = slotKeys[i];
      const slot = slotMap[key];
      if (!slot) {
        return { ok: false, error: 'One of your selected shifts is no longer on the schedule. Please refresh and try again.', schedule: getSchedulePayload_() };
      }
      const alreadySigned = myExisting.some(function (s) { return s.slotKey === key; });
      if (alreadySigned) {
        return { ok: false, error: 'You are already signed up for ' + slot.location + ' (' + slot.startTime + ' – ' + slot.endTime + ').' };
      }
      if (slot.remaining <= 0) {
        unavailableSlots.push(slot.location + ' (' + slot.startTime + ' – ' + slot.endTime + ')');
      } else {
        requestedSlots.push(slot);
      }
    }

    if (unavailableSlots.length > 0) {
      return {
        ok: false,
        error: 'Sorry! Someone just claimed the last spot for: ' + unavailableSlots.join(', ') + '. Please choose another open time slot.',
        unavailableSlots: unavailableSlots,
        schedule: getSchedulePayload_()
      };
    }

    // Check time overlaps (both among requested slots and against existing confirmed shifts)
    const overlapErr = findOverlapError_(requestedSlots, myExisting, slotMap);
    if (overlapErr) {
      return { ok: false, error: overlapErr };
    }

    const sheet = getOrCreateSignupsSheet_();
    const nowIso = new Date().toISOString();
    const newRows = [];

    requestedSlots.forEach(function (slot) {
      const signupId = generateSignupId_();
      newRows.push([
        signupId,
        slot.slotKey,
        slot.date,
        slot.location,
        slot.startTime,
        slot.endTime,
        slot.description,
        name,
        email,
        phone,
        editToken,
        'Confirmed',
        nowIso,
        '',
        '',
        notes
      ]);
    });

    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, newRows.length, SIGNUP_HEADERS.length).setValues(newRows);
    SpreadsheetApp.flush();

    const updatedSignups = loadSignups_();
    const myAllConfirmed = filterVolunteerConfirmed_(updatedSignups, email, slotMap);

    // Send confirmation email (with .ics calendar attachment & 15-min phone alarm)
    let emailSent = false;
    try {
      const subject = 'Confirmed: Your ' + (settings['Festival Name'] || 'Endless Mountains Pride') + ' Volunteer Shift' + (myAllConfirmed.length > 1 ? 's' : '');
      const html = buildConfirmationEmailHtml_(name, myAllConfirmed, editToken, settings, false);
      const plain = buildPlainScheduleText_(name, myAllConfirmed, editToken, settings);
      sendEmail_(email, subject, html, plain, settings, buildIcsAttachment_(myAllConfirmed, settings));
      emailSent = true;
    } catch (mailErr) {
      Logger.log('Confirmation email error: ' + mailErr);
    }

    const freshSchedule = getSchedulePayload_();
    return {
      ok: true,
      emailSent: emailSent,
      volunteer: { name: name, email: email, phone: phone, notes: notes },
      editToken: editToken,
      mySignups: myAllConfirmed,
      schedule: freshSchedule
    };
  } finally {
    lock.releaseLock();
  }
}

function handleLookup_(body) {
  const email = normalizeEmail_(body.email || '');
  const token = cleanStr_(body.token || '').toUpperCase();

  if (!token) {
    return { ok: false, error: 'Please enter your 6-character Manage Code (from your confirmation email).' };
  }

  const settings = loadSettings_();
  const allSlots = buildAllSlots_(settings);
  const signups = loadSignups_();
  const slotMap = indexBy_(allSlots, 'slotKey');

  // Match either by exact token alone (from magic link) or by email + token
  const matched = signups.filter(function (s) {
    const tokenMatch = s.editToken.toUpperCase() === token;
    if (!tokenMatch) return false;
    if (email) return normalizeEmail_(s.email) === email;
    return true;
  });

  if (matched.length === 0) {
    return { ok: false, error: 'We could not find a volunteer profile matching that email and Manage Code. Use "Email me my link" if you need a reminder.' };
  }

  const latest = matched[matched.length - 1];
  const volunteerEmail = normalizeEmail_(latest.email);
  const myConfirmed = filterVolunteerConfirmed_(signups, volunteerEmail, slotMap);

  return {
    ok: true,
    volunteer: {
      name: latest.name,
      email: volunteerEmail,
      phone: latest.phone,
      notes: latest.notes
    },
    editToken: latest.editToken,
    mySignups: myConfirmed
  };
}

function handleUpdateSignups_(body) {
  const email = normalizeEmail_(body.email || '');
  const token = cleanStr_(body.token || '').toUpperCase();
  const addSlotKeys = Array.isArray(body.addSlotKeys) ? uniqueStrings_(body.addSlotKeys) : [];
  const removeSignupIds = Array.isArray(body.removeSignupIds) ? uniqueStrings_(body.removeSignupIds) : [];

  if (!token) {
    return { ok: false, error: 'Missing Manage Code. Please sign in to My Shifts first.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, error: 'The signup sheet is busy right now. Please try again in a second.' };
  }

  try {
    const settings = loadSettings_();
    const allSlots = buildAllSlots_(settings);
    const signups = loadSignups_();

    // Authenticate volunteer via token (+ optional email)
    const ownedRows = signups.filter(function (s) {
      return s.editToken.toUpperCase() === token && (!email || normalizeEmail_(s.email) === email);
    });
    if (ownedRows.length === 0) {
      return { ok: false, error: 'Invalid Manage Code or email.' };
    }

    const latest = ownedRows[ownedRows.length - 1];
    const volEmail = normalizeEmail_(latest.email);
    const volName = cleanStr_(body.name) || latest.name;
    const volPhone = cleanStr_(body.phone) || latest.phone;
    const volNotes = body.notes !== undefined ? cleanStr_(body.notes) : latest.notes;

    // Simulate removals first so swapping into a freed/adjacent slot works cleanly
    const remainingSignups = signups.map(function (s) {
      if (removeSignupIds.indexOf(s.signupId) !== -1 && normalizeEmail_(s.email) === volEmail) {
        return Object.assign({}, s, { status: 'Cancelled' });
      }
      return s;
    });

    const enrichedAfterRemoval = attachAvailability_(allSlots, remainingSignups);
    const slotMap = indexBy_(enrichedAfterRemoval, 'slotKey');

    const myRemainingConfirmed = remainingSignups.filter(function (s) {
      return s.status === 'Confirmed' && normalizeEmail_(s.email) === volEmail;
    });

    const slotsToAdd = [];
    const unavailableSlots = [];

    for (let i = 0; i < addSlotKeys.length; i++) {
      const key = addSlotKeys[i];
      const slot = slotMap[key];
      if (!slot) {
        return { ok: false, error: 'Selected shift is no longer available on the schedule.', schedule: getSchedulePayload_() };
      }
      if (myRemainingConfirmed.some(function (s) { return s.slotKey === key; })) {
        return { ok: false, error: 'You are already signed up for ' + slot.location + ' (' + slot.startTime + ' – ' + slot.endTime + ').' };
      }
      if (slot.remaining <= 0) {
        unavailableSlots.push(slot.location + ' (' + slot.startTime + ' – ' + slot.endTime + ')');
      } else {
        slotsToAdd.push(slot);
      }
    }

    if (unavailableSlots.length > 0) {
      return {
        ok: false,
        error: 'Someone just grabbed the last spot for: ' + unavailableSlots.join(', ') + '. Your previous shift was NOT changed.',
        schedule: getSchedulePayload_()
      };
    }

    const overlapErr = findOverlapError_(slotsToAdd, myRemainingConfirmed, slotMap);
    if (overlapErr) {
      return { ok: false, error: overlapErr };
    }

    const sheet = getOrCreateSignupsSheet_();

    // Apply cancellations
    signups.forEach(function (s) {
      if (removeSignupIds.indexOf(s.signupId) !== -1 && normalizeEmail_(s.email) === volEmail && s.status === 'Confirmed') {
        sheet.getRange(s.rowNumber, 12).setValue('Cancelled');
      }
    });

    // Apply additions
    if (slotsToAdd.length > 0) {
      const nowIso = new Date().toISOString();
      const newRows = slotsToAdd.map(function (slot) {
        return [
          generateSignupId_(),
          slot.slotKey,
          slot.date,
          slot.location,
          slot.startTime,
          slot.endTime,
          slot.description,
          volName,
          volEmail,
          volPhone,
          latest.editToken,
          'Confirmed',
          nowIso,
          '',
          '',
          volNotes
        ];
      });
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, newRows.length, SIGNUP_HEADERS.length).setValues(newRows);
    }

    SpreadsheetApp.flush();

    const updatedSignups = loadSignups_();
    const freshSlots = buildAllSlots_(settings);
    const freshSlotMap = indexBy_(freshSlots, 'slotKey');
    const myConfirmed = filterVolunteerConfirmed_(updatedSignups, volEmail, freshSlotMap);

    // Send updated confirmation email
    try {
      const subject = 'Updated: Your ' + (settings['Festival Name'] || 'Endless Mountains Pride') + ' Volunteer Schedule';
      const html = buildConfirmationEmailHtml_(volName, myConfirmed, latest.editToken, settings, true);
      const plain = buildPlainScheduleText_(volName, myConfirmed, latest.editToken, settings);
      const ics = myConfirmed.length > 0 ? buildIcsAttachment_(myConfirmed, settings) : null;
      sendEmail_(volEmail, subject, html, plain, settings, ics);
    } catch (mailErr) {
      Logger.log('Update email error: ' + mailErr);
    }

    return {
      ok: true,
      volunteer: { name: volName, email: volEmail, phone: volPhone, notes: volNotes },
      editToken: latest.editToken,
      mySignups: myConfirmed,
      schedule: getSchedulePayload_()
    };
  } finally {
    lock.releaseLock();
  }
}

function handleCancelSignup_(body) {
  const signupIds = Array.isArray(body.signupIds)
    ? body.signupIds
    : (body.signupId ? [body.signupId] : []);
  if (signupIds.length === 0) {
    return { ok: false, error: 'No shift specified to remove.' };
  }
  return handleUpdateSignups_({
    email: body.email,
    token: body.token,
    addSlotKeys: [],
    removeSignupIds: signupIds
  });
}

function handleUpdateProfile_(body) {
  const email = normalizeEmail_(body.email || '');
  const token = cleanStr_(body.token || '').toUpperCase();
  const name = cleanStr_(body.name);
  const phone = cleanStr_(body.phone);
  const notes = cleanStr_(body.notes);

  if (!token || !name || !phone) {
    return { ok: false, error: 'Name, phone, and Manage Code are required.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, error: 'Sheet is busy. Please try again.' };
  }

  try {
    const signups = loadSignups_();
    const matched = signups.filter(function (s) {
      return s.editToken.toUpperCase() === token && (!email || normalizeEmail_(s.email) === email);
    });
    if (matched.length === 0) {
      return { ok: false, error: 'Invalid Manage Code.' };
    }

    const sheet = getOrCreateSignupsSheet_();
    matched.forEach(function (s) {
      sheet.getRange(s.rowNumber, 8).setValue(name);
      sheet.getRange(s.rowNumber, 10).setValue(phone);
      sheet.getRange(s.rowNumber, 16).setValue(notes);
    });
    SpreadsheetApp.flush();

    const settings = loadSettings_();
    const slotMap = indexBy_(buildAllSlots_(settings), 'slotKey');
    const updated = loadSignups_();
    const volEmail = normalizeEmail_(matched[0].email);

    return {
      ok: true,
      volunteer: { name: name, email: volEmail, phone: phone, notes: notes },
      editToken: matched[0].editToken,
      mySignups: filterVolunteerConfirmed_(updated, volEmail, slotMap)
    };
  } finally {
    lock.releaseLock();
  }
}

function handleSendAccessLink_(body) {
  const email = normalizeEmail_(body.email || '');
  if (!isValidEmail_(email)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }

  const settings = loadSettings_();
  const signups = loadSignups_();
  const mine = signups.filter(function (s) {
    return normalizeEmail_(s.email) === email;
  });

  if (mine.length > 0) {
    const latest = mine[mine.length - 1];
    const slotMap = indexBy_(buildAllSlots_(settings), 'slotKey');
    const confirmed = filterVolunteerConfirmed_(signups, email, slotMap);
    const subject = 'Your ' + (settings['Festival Name'] || 'Endless Mountains Pride') + ' Volunteer Manage Link';
    const html = buildConfirmationEmailHtml_(latest.name, confirmed, latest.editToken, settings, false);
    const plain = buildPlainScheduleText_(latest.name, confirmed, latest.editToken, settings);
    sendEmail_(email, subject, html, plain, settings, confirmed.length > 0 ? buildIcsAttachment_(confirmed, settings) : null);
  }

  // Always return friendly message
  return {
    ok: true,
    message: 'If there are shifts registered under ' + email + ', we just emailed your Manage Code and 1-click link!'
  };
}

// ============================================================================
// Automated Reminder Triggers (Day-Before + 15-Minute-Before)
// ============================================================================

function sendDayBeforeReminders() {
  const settings = loadSettings_();
  const tz = settings['Timezone'] || Session.getScriptTimeZone() || 'America/New_York';
  const sendHour = parseInt(settings['Day-Before Email Hour (0-23)'] || '10', 10);

  const now = new Date();
  const currentHour = parseInt(Utilities.formatDate(now, tz, 'H'), 10);
  if (currentHour < sendHour) {
    return 0; // Wait until the configured local hour
  }

  // Compute tomorrow's date string (YYYY-MM-DD) in festival timezone
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = Utilities.formatDate(tomorrowDate, tz, 'yyyy-MM-dd');

  const signups = loadSignups_();
  const slotMap = indexBy_(buildAllSlots_(settings), 'slotKey');

  // Group all unsent confirmed shifts for tomorrow by volunteer email
  const byEmail = {};
  signups.forEach(function (s) {
    if (s.status !== 'Confirmed') return;
    if (s.dayBeforeSent) return;
    if (s.date !== tomorrowStr) return;
    const key = normalizeEmail_(s.email);
    if (!byEmail[key]) {
      byEmail[key] = { name: s.name, email: key, editToken: s.editToken, rows: [] };
    }
    const slot = slotMap[s.slotKey];
    byEmail[key].rows.push(Object.assign({}, s, {
      checkInNote: slot ? slot.checkInNote : ''
    }));
  });

  const sheet = getOrCreateSignupsSheet_();
  const nowStamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm');
  let emailsSent = 0;

  Object.keys(byEmail).forEach(function (emailKey) {
    const group = byEmail[emailKey];
    group.rows.sort(function (a, b) {
      return parseTimeToMinutes_(a.startTime) - parseTimeToMinutes_(b.startTime);
    });

    try {
      const festivalName = settings['Festival Name'] || 'Endless Mountains Pride';
      const subject = 'Tomorrow! Your ' + festivalName + ' Volunteer Shift' + (group.rows.length > 1 ? 's' : '');
      const html = buildDayBeforeEmailHtml_(group.name, group.rows, group.editToken, settings);
      const plain = buildPlainScheduleText_(group.name, group.rows, group.editToken, settings);
      sendEmail_(group.email, subject, html, plain, settings, buildIcsAttachment_(group.rows, settings));

      group.rows.forEach(function (r) {
        sheet.getRange(r.rowNumber, 14).setValue(nowStamp);
      });
      emailsSent++;
    } catch (err) {
      Logger.log('Day-before reminder failed for ' + group.email + ': ' + err);
    }
  });

  return emailsSent;
}

function sendFifteenMinuteReminders() {
  const settings = loadSettings_();
  const tz = settings['Timezone'] || Session.getScriptTimeZone() || 'America/New_York';
  const now = new Date();
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const nowMinutes = parseInt(Utilities.formatDate(now, tz, 'H'), 10) * 60 +
    parseInt(Utilities.formatDate(now, tz, 'm'), 10);

  const signups = loadSignups_();
  const slotMap = indexBy_(buildAllSlots_(settings), 'slotKey');
  const sheet = getOrCreateSignupsSheet_();
  const nowStamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm');
  let emailsSent = 0;

  signups.forEach(function (s) {
    if (s.status !== 'Confirmed') return;
    if (s.fifteenMinSent) return;
    if (s.date !== todayStr) return;

    const startMin = parseTimeToMinutes_(s.startTime);
    if (startMin === null) return;

    const minsUntilStart = startMin - nowMinutes;
    // Trigger runs every 5 minutes; 8..22 min window catches the 15-minute mark reliably without missing or firing early
    if (minsUntilStart >= 8 && minsUntilStart <= 22) {
      try {
        const slot = slotMap[s.slotKey];
        const checkInNote = (slot && slot.checkInNote) || settings['Check-In Instructions'] || '';
        const festivalName = settings['Festival Name'] || 'Endless Mountains Pride';
        const subject = '⏰ Starts in ' + Math.max(10, Math.round(minsUntilStart)) + ' min: ' + s.location + ' (' + s.startTime + ') — ' + festivalName;
        const html = buildFifteenMinEmailHtml_(s, checkInNote, minsUntilStart, settings);
        const plain =
          'Hi ' + s.name + ',\n\n' +
          'Quick heads-up — your volunteer shift starts in about ' + Math.round(minsUntilStart) + ' minutes!\n\n' +
          'Location: ' + s.location + '\n' +
          'Time: ' + s.startTime + ' – ' + s.endTime + '\n' +
          'Duties: ' + s.description + '\n' +
          (checkInNote ? 'Check-in: ' + checkInNote + '\n' : '') +
          '\nThank you for making ' + festivalName + ' amazing!';

        sendEmail_(s.email, subject, html, plain, settings, null);
        sheet.getRange(s.rowNumber, 15).setValue(nowStamp);
        emailsSent++;
      } catch (err) {
        Logger.log('15-min reminder failed for ' + s.email + ': ' + err);
      }
    }
  });

  return emailsSent;
}

// ============================================================================
// Sheet Readers & Shift-Splitting Engine
// ============================================================================

function loadSettings_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_SETTINGS);
  const settings = {
    'Festival Name': 'Endless Mountains Pride',
    'Venue': 'Mountaineer Park',
    'Location Subtitle': 'Endless Mountains, PA',
    'Timezone': 'America/New_York',
    'Default Shift Length (hrs)': '2',
    'Coordinator Name': 'Endless Mountains Pride Volunteer Team',
    'Coordinator Email': '',
    'Coordinator Phone': '',
    'Volunteer Web App URL': '',
    'Announcement': '',
    'Check-In Instructions': '',
    'Day-Before Email Hour (0-23)': '10'
  };
  if (!sheet || sheet.getLastRow() < 2) return settings;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
  rows.forEach(function (r) {
    const k = cleanStr_(r[0]);
    const v = cleanStr_(r[1]);
    if (k) settings[k] = v;
  });
  return settings;
}

function sanitizePublicSettings_(settings) {
  return {
    festivalName: settings['Festival Name'] || 'Endless Mountains Pride',
    venue: settings['Venue'] || 'Mountaineer Park',
    locationSubtitle: settings['Location Subtitle'] || 'Endless Mountains, PA',
    timezone: settings['Timezone'] || 'America/New_York',
    defaultShiftLength: settings['Default Shift Length (hrs)'] || '2',
    coordinatorName: settings['Coordinator Name'] || 'Volunteer Team',
    coordinatorEmail: settings['Coordinator Email'] || '',
    coordinatorPhone: settings['Coordinator Phone'] || '',
    announcement: settings['Announcement'] || '',
    checkInInstructions: settings['Check-In Instructions'] || ''
  };
}

function buildAllSlots_(settings) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_SHIFTS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const numCols = Math.max(8, sheet.getLastColumn());
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getDisplayValues();
  const defaultLen = parseShiftLengthHours_(settings['Default Shift Length (hrs)'], 2);
  const slots = [];
  const seenKeys = {};

  rows.forEach(function (row, idx) {
    const rawDate = cleanStr_(row[0]);
    const location = cleanStr_(row[1]);
    const needed = parseInt(cleanStr_(row[2]), 10);
    const timeRange = cleanStr_(row[3]);
    const rawLen = cleanStr_(row[4]);
    const description = cleanStr_(row[5]);
    const category = cleanStr_(row[6]) || 'General';
    const checkInNote = cleanStr_(row[7]) || '';

    if (!rawDate || !location || !timeRange || isNaN(needed) || needed <= 0) return;

    const isoDate = normalizeDateStr_(rawDate);
    const parsedRange = parseTimeRange_(timeRange);
    if (!isoDate || !parsedRange) return;

    const shiftLenHrs = parseShiftLengthHours_(rawLen, defaultLen);
    const stepMinutes = shiftLenHrs > 0 ? Math.round(shiftLenHrs * 60) : (parsedRange.endMin - parsedRange.startMin);

    let cursor = parsedRange.startMin;
    while (cursor < parsedRange.endMin) {
      const next = Math.min(cursor + stepMinutes, parsedRange.endMin);
      // Avoid tiny < 30-min sliver at the end by merging if needed
      let blockEnd = next;
      if (parsedRange.endMin - next > 0 && parsedRange.endMin - next < 30) {
        blockEnd = parsedRange.endMin;
      }

      const startStr = formatMinutes12h_(cursor);
      const endStr = formatMinutes12h_(blockEnd);
      const slotKey = isoDate + '|' + location + '|' + pad4_(cursor) + '-' + pad4_(blockEnd);

      if (!seenKeys[slotKey]) {
        seenKeys[slotKey] = true;
        slots.push({
          slotKey: slotKey,
          rowIndex: idx + 2,
          date: isoDate,
          location: location,
          category: category,
          capacity: needed,
          startMinutes: cursor,
          endMinutes: blockEnd,
          startTime: startStr,
          endTime: endStr,
          description: description,
          checkInNote: checkInNote
        });
      }

      cursor = blockEnd;
    }
  });

  slots.sort(function (a, b) {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.startMinutes !== b.startMinutes) return a.startMinutes - b.startMinutes;
    return a.location.localeCompare(b.location);
  });

  return slots;
}

function getOrCreateSignupsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TAB_SIGNUPS);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_SIGNUPS);
    sheet.getRange(1, 1, 1, SIGNUP_HEADERS.length).setValues([SIGNUP_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function loadSignups_() {
  const sheet = getOrCreateSignupsSheet_();
  if (sheet.getLastRow() < 2) return [];
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, SIGNUP_HEADERS.length).getDisplayValues();
  const list = [];

  rows.forEach(function (r, idx) {
    const signupId = cleanStr_(r[0]);
    const slotKey = cleanStr_(r[1]);
    if (!signupId || !slotKey) return;
    list.push({
      rowNumber: idx + 2,
      signupId: signupId,
      slotKey: slotKey,
      date: normalizeDateStr_(r[2]) || cleanStr_(r[2]),
      location: cleanStr_(r[3]),
      startTime: cleanStr_(r[4]),
      endTime: cleanStr_(r[5]),
      description: cleanStr_(r[6]),
      name: cleanStr_(r[7]),
      email: normalizeEmail_(r[8]),
      phone: cleanStr_(r[9]),
      editToken: cleanStr_(r[10]),
      status: cleanStr_(r[11]) || 'Confirmed',
      signedUpAt: cleanStr_(r[12]),
      dayBeforeSent: cleanStr_(r[13]),
      fifteenMinSent: cleanStr_(r[14]),
      notes: cleanStr_(r[15])
    });
  });

  return list;
}

function attachAvailability_(slots, signups) {
  const counts = {};
  signups.forEach(function (s) {
    if (s.status === 'Confirmed') {
      counts[s.slotKey] = (counts[s.slotKey] || 0) + 1;
    }
  });

  return slots.map(function (slot) {
    const filled = counts[slot.slotKey] || 0;
    const remaining = Math.max(0, slot.capacity - filled);
    return Object.assign({}, slot, {
      filled: filled,
      remaining: remaining,
      available: remaining > 0
    });
  });
}

function filterVolunteerConfirmed_(signups, email, slotMap) {
  return signups
    .filter(function (s) {
      return s.status === 'Confirmed' && normalizeEmail_(s.email) === email;
    })
    .map(function (s) {
      const slot = slotMap[s.slotKey];
      return {
        signupId: s.signupId,
        slotKey: s.slotKey,
        date: s.date,
        location: s.location,
        startTime: s.startTime,
        endTime: s.endTime,
        startMinutes: parseTimeToMinutes_(s.startTime),
        endMinutes: parseTimeToMinutes_(s.endTime),
        description: s.description || (slot ? slot.description : ''),
        category: slot ? slot.category : 'General',
        checkInNote: slot ? slot.checkInNote : '',
        notes: s.notes,
        signedUpAt: s.signedUpAt
      };
    })
    .sort(function (a, b) {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.startMinutes || 0) - (b.startMinutes || 0);
    });
}

// ============================================================================
// Email Builders & .ics Calendar Generator (with 15-Min Phone Alarm)
// ============================================================================

function sendEmail_(to, subject, htmlBody, plainBody, settings, icsAttachment) {
  const options = {
    name: settings['Coordinator Name'] || 'Endless Mountains Pride Volunteer Team',
    htmlBody: htmlBody
  };
  if (settings['Coordinator Email']) {
    options.replyTo = settings['Coordinator Email'];
  }
  if (icsAttachment) {
    options.attachments = [icsAttachment];
  }
  MailApp.sendEmail(to, subject, plainBody, options);
}

function getManageUrl_(editToken, settings) {
  const base = cleanStr_(settings['Volunteer Web App URL'] || '');
  if (!base) return '';
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return base.replace(/#.*$/, '') + sep + 'token=' + encodeURIComponent(editToken) + '#my-shifts';
}

function buildConfirmationEmailHtml_(name, shifts, editToken, settings, isUpdate) {
  const festivalName = settings['Festival Name'] || 'Endless Mountains Pride';
  const venue = settings['Venue'] || 'Mountaineer Park';
  const checkIn = settings['Check-In Instructions'] || '';
  const manageUrl = getManageUrl_(editToken, settings);

  const heading = isUpdate
    ? 'Your Volunteer Schedule Has Been Updated'
    : 'You’re Signed Up to Volunteer!';
  const intro = shifts.length > 0
    ? 'Thank you so much for supporting <strong>' + escapeHtml_(festivalName) + '</strong> at ' + escapeHtml_(venue) + '. Here are your confirmed shifts:'
    : 'Your previous volunteer shifts have been removed and reopened for other volunteers. Thank you for letting us know!';

  const shiftCards = shifts.map(function (s) {
    return (
      '<div style="background:#FAF8F3;border:1px solid #E5DEC9;border-radius:12px;padding:16px 18px;margin-bottom:12px;">' +
        '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#1E6F4E;margin-bottom:4px;">' +
          escapeHtml_(formatFriendlyDate_(s.date)) + ' · ' + escapeHtml_(s.startTime) + ' – ' + escapeHtml_(s.endTime) +
        '</div>' +
        '<div style="font-size:17px;font-weight:700;color:#17322B;margin-bottom:6px;">' + escapeHtml_(s.location) + '</div>' +
        '<div style="font-size:14px;color:#4B6059;line-height:1.5;">' + escapeHtml_(s.description || '') + '</div>' +
        (s.checkInNote ? '<div style="margin-top:8px;font-size:13px;color:#17322B;background:#E4F3EC;padding:8px 10px;border-radius:8px;"><strong>Check-in:</strong> ' + escapeHtml_(s.checkInNote) + '</div>' : '') +
      '</div>'
    );
  }).join('');

  return wrapEmailLayout_(
    festivalName,
    heading,
    '<p style="margin:0 0 16px;font-size:15px;color:#17322B;line-height:1.6;">Hi ' + escapeHtml_(name) + ',</p>' +
      '<p style="margin:0 0 18px;font-size:15px;color:#4B6059;line-height:1.6;">' + intro + '</p>' +
      shiftCards +
      (checkIn && shifts.length > 0
        ? '<div style="background:#F3EFE6;border-radius:10px;padding:14px 16px;margin:18px 0;font-size:14px;color:#17322B;line-height:1.55;"><strong>Festival Check-In:</strong> ' + escapeHtml_(checkIn) + '</div>'
        : '') +
      '<div style="background:#FFFFFF;border:1px dashed #CFC5AE;border-radius:12px;padding:16px;margin:20px 0;text-align:center;">' +
        '<div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#6C7D76;font-weight:700;">Need to Change or Cancel a Shift?</div>' +
        '<div style="font-size:22px;font-weight:800;letter-spacing:0.16em;color:#17322B;margin:6px 0 10px;">' + escapeHtml_(editToken) + '</div>' +
        '<div style="font-size:13px;color:#4B6059;margin-bottom:14px;">Use this Manage Code anytime in the app under <strong>My Shifts</strong>.</div>' +
        (manageUrl
          ? '<a href="' + escapeHtml_(manageUrl) + '" style="display:inline-block;background:#1E6F4E;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:999px;">Manage My Shifts</a>'
          : '') +
      '</div>' +
      (shifts.length > 0
        ? '<p style="font-size:13px;color:#6C7D76;line-height:1.5;margin:14px 0 0;">We’ve also attached a calendar file (<strong>.ics</strong>) with a built-in 15-minute phone reminder, and we’ll email you both the day before and 15 minutes before each shift.</p>'
        : '')
  );
}

function buildDayBeforeEmailHtml_(name, shifts, editToken, settings) {
  const festivalName = settings['Festival Name'] || 'Endless Mountains Pride';
  const venue = settings['Venue'] || 'Mountaineer Park';
  const checkIn = settings['Check-In Instructions'] || '';
  const manageUrl = getManageUrl_(editToken, settings);

  const shiftCards = shifts.map(function (s) {
    return (
      '<div style="background:#FAF8F3;border:1px solid #E5DEC9;border-radius:12px;padding:16px 18px;margin-bottom:12px;">' +
        '<div style="font-size:13px;font-weight:700;color:#1E6F4E;margin-bottom:4px;">' + escapeHtml_(s.startTime) + ' – ' + escapeHtml_(s.endTime) + '</div>' +
        '<div style="font-size:17px;font-weight:700;color:#17322B;margin-bottom:6px;">' + escapeHtml_(s.location) + '</div>' +
        '<div style="font-size:14px;color:#4B6059;line-height:1.5;">' + escapeHtml_(s.description || '') + '</div>' +
        (s.checkInNote ? '<div style="margin-top:8px;font-size:13px;color:#17322B;background:#E4F3EC;padding:8px 10px;border-radius:8px;"><strong>Note:</strong> ' + escapeHtml_(s.checkInNote) + '</div>' : '') +
      '</div>'
    );
  }).join('');

  return wrapEmailLayout_(
    festivalName,
    'See You Tomorrow at ' + venue + '!',
    '<p style="margin:0 0 14px;font-size:15px;color:#17322B;">Hi ' + escapeHtml_(name) + ',</p>' +
      '<p style="margin:0 0 18px;font-size:15px;color:#4B6059;line-height:1.6;">Friendly reminder that your volunteer shift' + (shifts.length > 1 ? 's are' : ' is') + ' <strong>tomorrow (' + escapeHtml_(formatFriendlyDate_(shifts[0].date)) + ')</strong>! We’re so grateful to have you on the crew.</p>' +
      shiftCards +
      (checkIn ? '<div style="background:#F3EFE6;border-radius:10px;padding:14px 16px;margin:16px 0;font-size:14px;color:#17322B;"><strong>Check-In Info:</strong> ' + escapeHtml_(checkIn) + '</div>' : '') +
      (settings['Coordinator Phone'] ? '<p style="font-size:14px;color:#4B6059;">Day-of volunteer hotline: <strong>' + escapeHtml_(settings['Coordinator Phone']) + '</strong></p>' : '') +
      '<p style="font-size:13px;color:#6C7D76;margin-top:16px;">Plans changed? Please release your spot so another volunteer can step in. ' +
      (manageUrl ? '<a href="' + escapeHtml_(manageUrl) + '" style="color:#1E6F4E;font-weight:700;">Change or cancel my shifts</a>' : 'Manage Code: <strong>' + escapeHtml_(editToken) + '</strong>') +
      '</p>'
  );
}

function buildFifteenMinEmailHtml_(signup, checkInNote, minsUntilStart, settings) {
  const festivalName = settings['Festival Name'] || 'Endless Mountains Pride';
  const venue = settings['Venue'] || 'Mountaineer Park';
  const rounded = Math.max(10, Math.round(minsUntilStart));

  return wrapEmailLayout_(
    festivalName,
    '⏰ Your Shift Starts in ' + rounded + ' Minutes!',
    '<p style="margin:0 0 14px;font-size:15px;color:#17322B;">Hi ' + escapeHtml_(signup.name) + ',</p>' +
      '<p style="margin:0 0 16px;font-size:15px;color:#4B6059;line-height:1.55;">It’s almost go-time at <strong>' + escapeHtml_(venue) + '</strong>! Please head toward your station:</p>' +
      '<div style="background:#E4F3EC;border:1px solid #1E6F4E;border-radius:12px;padding:18px;margin-bottom:16px;">' +
        '<div style="font-size:13px;font-weight:700;color:#145038;text-transform:uppercase;letter-spacing:0.06em;">' + escapeHtml_(signup.startTime) + ' – ' + escapeHtml_(signup.endTime) + '</div>' +
        '<div style="font-size:20px;font-weight:800;color:#17322B;margin:4px 0 8px;">' + escapeHtml_(signup.location) + '</div>' +
        '<div style="font-size:14px;color:#17322B;line-height:1.5;">' + escapeHtml_(signup.description || '') + '</div>' +
      '</div>' +
      (checkInNote ? '<p style="font-size:14px;color:#4B6059;line-height:1.5;"><strong>Check-in:</strong> ' + escapeHtml_(checkInNote) + '</p>' : '') +
      (settings['Coordinator Phone'] ? '<p style="font-size:14px;color:#4B6059;">Running a few minutes late? Text/call: <strong>' + escapeHtml_(settings['Coordinator Phone']) + '</strong></p>' : '')
  );
}

function wrapEmailLayout_(festivalName, title, innerHtml) {
  return (
    '<div style="background:#FAF8F3;padding:24px 14px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">' +
      '<div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:18px;overflow:hidden;border:1px solid #E5DEC9;">' +
        '<div style="height:6px;background:linear-gradient(90deg,#F5A9B8 0%,#5BCEFA 18%,#6B3FA0 36%,#3E4FA8 50%,#1E8449 64%,#F4E424 78%,#F39221 90%,#C62839 100%);"></div>' +
        '<div style="background:#17322B;color:#FFFFFF;padding:22px 24px;">' +
          '<div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#A7D7C2;">' + escapeHtml_(festivalName) + ' · Volunteer Hub</div>' +
          '<h1 style="margin:6px 0 0;font-size:22px;line-height:1.25;font-weight:700;color:#FFFFFF;">' + escapeHtml_(title) + '</h1>' +
        '</div>' +
        '<div style="padding:24px;">' + innerHtml + '</div>' +
        '<div style="background:#F3EFE6;padding:14px 24px;font-size:12px;color:#6C7D76;text-align:center;">' +
          escapeHtml_(festivalName) + ' · Thank you for building rural queer joy together!' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function buildPlainScheduleText_(name, shifts, editToken, settings) {
  const festivalName = settings['Festival Name'] || 'Endless Mountains Pride';
  const lines = ['Hi ' + name + ',', '', 'Your ' + festivalName + ' volunteer shifts:', ''];
  if (shifts.length === 0) {
    lines.push('(No active shifts — all previously selected shifts were cancelled.)');
  } else {
    shifts.forEach(function (s) {
      lines.push('- ' + formatFriendlyDate_(s.date) + ' | ' + s.startTime + ' - ' + s.endTime + ' | ' + s.location);
      if (s.description) lines.push('  Duties: ' + s.description);
    });
  }
  lines.push('', 'Manage Code: ' + editToken);
  const url = getManageUrl_(editToken, settings);
  if (url) lines.push('Manage your shifts online: ' + url);
  return lines.join('\n');
}

function buildIcsAttachment_(shifts, settings) {
  if (!shifts || shifts.length === 0) return null;
  const festivalName = settings['Festival Name'] || 'Endless Mountains Pride';
  const venue = settings['Venue'] || 'Mountaineer Park';
  const tz = settings['Timezone'] || 'America/New_York';
  const nowStamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Endless Mountains Pride//Volunteer Hub//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + escapeIcs_(festivalName + ' Volunteer Shifts'),
    'X-WR-TIMEZONE:' + tz
  ];

  shifts.forEach(function (s, i) {
    const startMin = parseTimeToMinutes_(s.startTime);
    const endMin = parseTimeToMinutes_(s.endTime);
    if (startMin === null || endMin === null || !s.date) return;
    const dateCompact = s.date.replace(/-/g, '');
    const dtStart = dateCompact + 'T' + minutesToIcsTime_(startMin);
    const dtEnd = dateCompact + 'T' + minutesToIcsTime_(endMin);

    lines.push(
      'BEGIN:VEVENT',
      'UID:' + (s.signupId || ('emp-' + i)) + '@endlessmountainspride.org',
      'DTSTAMP:' + nowStamp,
      'DTSTART;TZID=' + tz + ':' + dtStart,
      'DTEND;TZID=' + tz + ':' + dtEnd,
      'SUMMARY:' + escapeIcs_('Volunteer: ' + s.location + ' (' + festivalName + ')'),
      'LOCATION:' + escapeIcs_(s.location + ', ' + venue),
      'DESCRIPTION:' + escapeIcs_((s.description || '') + (s.checkInNote ? '\\n\\nCheck-in: ' + s.checkInNote : '')),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'DESCRIPTION:' + escapeIcs_('Volunteer shift starts in 15 minutes at ' + s.location),
      'END:VALARM',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  return Utilities.newBlob(lines.join('\r\n'), 'text/calendar', 'endless-mountains-pride-shifts.ics');
}

// ============================================================================
// Parsing, Overlap & Utility Helpers
// ============================================================================

function findOverlapError_(newSlots, existingConfirmed, slotMap) {
  const combined = [];
  existingConfirmed.forEach(function (s) {
    const startMin = parseTimeToMinutes_(s.startTime);
    const endMin = parseTimeToMinutes_(s.endTime);
    if (startMin !== null && endMin !== null) {
      combined.push({ date: s.date, startMinutes: startMin, endMinutes: endMin, label: s.location + ' (' + s.startTime + ' – ' + s.endTime + ')' });
    }
  });
  newSlots.forEach(function (slot) {
    combined.push({ date: slot.date, startMinutes: slot.startMinutes, endMinutes: slot.endMinutes, label: slot.location + ' (' + slot.startTime + ' – ' + slot.endTime + ')' });
  });

  for (let i = 0; i < combined.length; i++) {
    for (let j = i + 1; j < combined.length; j++) {
      const a = combined[i];
      const b = combined[j];
      if (a.date === b.date && a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes) {
        return 'Time conflict: ' + a.label + ' overlaps with ' + b.label + '. Please choose non-overlapping shifts.';
      }
    }
  }
  return null;
}

function findOrCreateToken_(signups, email) {
  for (let i = signups.length - 1; i >= 0; i--) {
    if (normalizeEmail_(signups[i].email) === email && signups[i].editToken) {
      return signups[i].editToken.toUpperCase();
    }
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return code;
}

function generateSignupId_() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'EMP-';
  for (let i = 0; i < 6; i++) {
    id += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return id;
}

function parseShiftLengthHours_(raw, fallback) {
  const val = cleanStr_(raw).toLowerCase();
  if (!val) return fallback;
  if (val === 'full' || val === 'all' || val === 'none' || val === '0' || val === 'single') return 0;
  const num = parseFloat(val);
  return (!isNaN(num) && num > 0) ? num : fallback;
}

function normalizeDateStr_(raw) {
  const str = cleanStr_(raw);
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Handle "June 4", "June 4, 2027", "6/4/2027", etc.
  let candidate = str;
  if (!/\d{4}/.test(candidate)) {
    candidate = candidate + ', ' + new Date().getFullYear();
  }
  const d = new Date(candidate);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = ('0' + (d.getMonth() + 1)).slice(-2);
  const day = ('0' + d.getDate()).slice(-2);
  return y + '-' + m + '-' + day;
}

function parseTimeRange_(raw) {
  const str = cleanStr_(raw);
  if (!str) return null;
  const parts = str.split(/\s*(?:-|–|—|\bto\b)\s*/i);
  if (parts.length !== 2) return null;
  const startMin = parseTimeToMinutes_(parts[0]);
  const endMin = parseTimeToMinutes_(parts[1]);
  if (startMin === null || endMin === null || endMin <= startMin) return null;
  return { startMin: startMin, endMin: endMin };
}

function parseTimeToMinutes_(raw) {
  const str = cleanStr_(raw).toLowerCase();
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const mins = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3] ? match[3].toLowerCase() : null;

  if (period === 'pm' && hours < 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;
  return hours * 60 + mins;
}

function formatMinutes12h_(totalMin) {
  const h24 = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return h12 + ':' + ('0' + m).slice(-2) + ' ' + period;
}

function minutesToIcsTime_(totalMin) {
  const h = ('0' + Math.floor(totalMin / 60)).slice(-2);
  const m = ('0' + (totalMin % 60)).slice(-2);
  return h + m + '00';
}

function formatFriendlyDate_(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const parts = isoDate.split('-');
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function pad4_(n) {
  const h = ('0' + Math.floor(n / 60)).slice(-2);
  const m = ('0' + (n % 60)).slice(-2);
  return h + m;
}

function cleanStr_(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

function normalizeEmail_(v) {
  return cleanStr_(v).toLowerCase();
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function uniqueStrings_(arr) {
  const seen = {};
  const out = [];
  arr.forEach(function (v) {
    const s = cleanStr_(v);
    if (s && !seen[s]) {
      seen[s] = true;
      out.push(s);
    }
  });
  return out;
}

function indexBy_(list, prop) {
  const map = {};
  list.forEach(function (item) { map[item[prop]] = item; });
  return map;
}

function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeIcs_(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
