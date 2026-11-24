/**
 * Endless Mountains Pride — Volunteer Hub Configuration & Fallback Data
 *
 * Connected Google Sheet:
 * https://docs.google.com/spreadsheets/d/1DlMO46XIRxLcecUuuNHkvygCx3Ss7wlT9oTBcwjvxEE/edit
 *
 * To activate LIVE multi-user signups & automated Day-Before + 15-Minute emails:
 * 1. Open the Google Sheet above → Extensions → Apps Script
 * 2. Paste apps-script/Code.gs → Save → Deploy → New deployment → Web app
 *    (Execute as: Me · Who has access: Anyone)
 * 3. Paste your Web App URL (ending in /exec) into APPS_SCRIPT_URL below!
 * 4. Reload the Google Sheet → click "🏳️‍🌈 Volunteer Hub" → "Enable Automated Reminders".
 */

window.EMP_VOLUNTEER_CONFIG = {
  SHEET_ID: '1DlMO46XIRxLcecUuuNHkvygCx3Ss7wlT9oTBcwjvxEE',

  // Paste your deployed Google Apps Script Web App URL here (ends in /exec)
  // Leave blank to run in Interactive Local Preview Mode (saves locally in your browser)
  APPS_SCRIPT_URL: '',

  FESTIVAL_GUIDE_URL: 'https://endlessmountainspride.github.io/endless-mountains-pride/',

  // Fallback data matching the newly created Google Sheet (used in Preview Mode or offline)
  FALLBACK_SETTINGS: {
    festivalName: 'Endless Mountains Pride',
    venue: 'Mountaineer Park',
    locationSubtitle: 'Endless Mountains, PA',
    timezone: 'America/New_York',
    defaultShiftLength: '2',
    coordinatorName: 'Endless Mountains Pride Volunteer Team',
    coordinatorEmail: '',
    coordinatorPhone: '',
    announcement: 'Thank you for stepping up for Endless Mountains Pride! All volunteers receive a free festival tee, shaded rest breaks, and cold water all day.',
    checkInInstructions: 'Please arrive 10 minutes before your shift and check in at the emPRIDE & Drinks tent in the center grounds to grab your volunteer shirt and shift briefing.'
  },

  FALLBACK_SHIFTS: [
    {
      date: '2027-06-11',
      location: 'Festival Grounds Setup',
      needed: 4,
      timeRange: '4:00 PM - 7:00 PM',
      shiftLength: 'Full',
      description: 'Help set up canopies, fold-out vendor tables, directional signs, and perimeter fencing across Mountaineer Park before festival morning.',
      category: 'Setup & Teardown',
      checkInNote: 'Meet at the Main Entrance gate. Bring work gloves and water; light lifting involved.'
    },
    {
      date: '2027-06-12',
      location: 'Morning Setup & Vendor Check-In',
      needed: 3,
      timeRange: '8:30 AM - 10:30 AM',
      shiftLength: 'Full',
      description: 'Greet arriving vendors and nonprofits, direct vehicles to unloading zones, and help booths locate their assigned numbers.',
      category: 'Setup & Teardown',
      checkInNote: 'Check in at the emPRIDE & Drinks tent by 8:20 AM for booth map & radio.'
    },
    {
      date: '2027-06-12',
      location: 'Main Entrance',
      needed: 2,
      timeRange: '10:00 AM - 5:00 PM',
      shiftLength: '2',
      description: 'Welcoming attendees at the East Gate canopy, answering quick festival questions, and handing out festival wristbands.',
      category: 'Gates & Welcome',
      checkInNote: 'Check in 10 min early at emPRIDE & Drinks tent for your volunteer shirt & wristbands.'
    },
    {
      date: '2027-06-12',
      location: 'Foot Entrance',
      needed: 2,
      timeRange: '11:00 AM - 5:00 PM',
      shiftLength: '2',
      description: 'Greeting walk-in guests at the South-West gate next to the BBQ Pit, handing out wristbands, and sharing grounds maps.',
      category: 'Gates & Welcome',
      checkInNote: 'Shaded canopy & chairs provided. Pick up wristbands at emPRIDE & Drinks tent.'
    },
    {
      date: '2027-06-12',
      location: 'Parking Field',
      needed: 2,
      timeRange: '10:30 AM - 4:30 PM',
      shiftLength: '2',
      description: 'Guiding incoming cars smoothly into the East Parking Field and keeping accessible parking spaces near the Main Entrance clear.',
      category: 'Parking & Access',
      checkInNote: 'High-vis vest, cold water, and shade umbrella provided at the East Field gate.'
    },
    {
      date: '2027-06-12',
      location: 'emPRIDE & Drinks',
      needed: 2,
      timeRange: '11:00 AM - 6:00 PM',
      shiftLength: '2',
      description: 'Staffing the official Endless Mountains Pride hub: handing out free water, selling merch & cold drinks, and helping attendees find booths.',
      category: 'Festival Hub',
      checkInNote: 'Center grounds shaded tent. Quick 5-minute POS walkthrough at shift handoff.'
    },
    {
      date: '2027-06-12',
      location: 'Quiet Corner Canopy',
      needed: 1,
      timeRange: '11:30 AM - 5:30 PM',
      shiftLength: '2',
      description: 'Hosting our sensory-friendly calm space — replenishing art & bubble supplies, offering ear plugs/water, and keeping the canopy welcoming.',
      category: 'Activities & Care',
      checkInNote: 'South-East shaded canopy. Seated, low-noise, family-friendly role.'
    },
    {
      date: '2027-06-12',
      location: 'Dunk Tank & Games',
      needed: 2,
      timeRange: '12:30 PM - 4:30 PM',
      shiftLength: '2',
      description: 'Running the community fundraiser dunk tank line, collecting donation tickets, and helping coordinate friendly cornhole brackets.',
      category: 'Activities & Care',
      checkInNote: 'Center-South grounds near the water hookup. Fun, high-energy role!'
    },
    {
      date: '2027-06-12',
      location: 'Grounds Floater & Water Runner',
      needed: 2,
      timeRange: '11:00 AM - 5:00 PM',
      shiftLength: '2',
      description: 'Checking in on booth volunteers for quick restroom/shade breaks, restocking water coolers, and tidying recycling/trash stations.',
      category: 'Festival Hub',
      checkInNote: 'Great for volunteers who like moving around and seeing the whole park!'
    },
    {
      date: '2027-06-12',
      location: 'Festival Teardown & Pack-Up',
      needed: 4,
      timeRange: '6:00 PM - 8:00 PM',
      shiftLength: 'Full',
      description: 'Help take down festival canopies, coil extension cords, load signage, and leave Mountaineer Park sparkling clean.',
      category: 'Setup & Teardown',
      checkInNote: 'Meet at emPRIDE & Drinks tent right after the closing dance party. Snacks provided!'
    }
  ]
};
