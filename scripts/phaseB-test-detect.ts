/** Unit checks for messenger/social detection (no network, no DB). */
import { detectContacts, normalizeMsisdn, cleanProfileUrl, classifySocialUrl } from '../src/enrichment/messengers.js';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`, extra ?? ''); }
}
const has = (r: ReturnType<typeof detectContacts>, ch: string, v?: string) =>
  r.some((c) => c.channel === ch && (v === undefined || c.value === v));

console.log('# wa.me link');
{
  const r = detectContacts(`<a href="https://wa.me/306912345678">Γράψε μας</a>`);
  check('whatsapp detected with number', has(r, 'whatsapp', '306912345678'), r);
  check('carries evidence snippet', (r[0]?.evidence ?? '').includes('wa.me'), r[0]);
}
console.log('# api.whatsapp.com');
{
  const r = detectContacts(`<a href="https://api.whatsapp.com/send?phone=%2B306912345678&text=hi">WhatsApp</a>`);
  check('whatsapp from api link', has(r, 'whatsapp'), r);
}
console.log('# viber deep link');
{
  const r = detectContacts(`<a href="viber://chat?number=%2B306944444444">Viber</a>`);
  check('viber detected', has(r, 'viber', '+306944444444'), r);
}
console.log('# word marker near phone');
{
  const r = detectContacts(`Καλέστε μας: 2610 22 33 44 ή στο WhatsApp 6912 345 678`);
  check('whatsapp via word marker', has(r, 'whatsapp'), r);
}
console.log('# NO false positive: bare phone without marker');
{
  const r = detectContacts(`<p>Τηλέφωνο: 2610 223344</p>`);
  check('no whatsapp invented', !has(r, 'whatsapp'), r);
  check('no viber invented', !has(r, 'viber'), r);
}
console.log('# instagram/facebook profiles vs noise');
{
  const r = detectContacts(`
    <a href="https://www.instagram.com/velvet.cosmetic.lounge/">IG</a>
    <a href="https://www.instagram.com/p/CxYz123/">a post</a>
    <a href="https://www.facebook.com/xenoshaircaffe/">FB</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>`);
  check('instagram profile kept', has(r, 'instagram', 'https://instagram.com/velvet.cosmetic.lounge'), r.filter(x=>x.channel==='instagram'));
  check('instagram /p/ post rejected', !r.some((c) => c.channel === 'instagram' && c.value.includes('/p/')), r);
  check('facebook page kept', has(r, 'facebook', 'https://facebook.com/xenoshaircaffe'), r.filter(x=>x.channel==='facebook'));
  check('facebook sharer rejected', !r.some((c) => c.value.includes('sharer')), r);
}
console.log('# instagram deep-link artefacts (flagged by the QA agent on the real run)');
{
  const r = detectContacts(`
    <a href="https://www.instagram.com/velvet.cosmetic.lounge">real</a>
    <meta content="https://www.instagram.com/_u">
    <a href="https://instagram.com/_n/xyz">deep link</a>
    <a href="https://instagram.com/__">underscores only</a>`);
  check('real handle kept', has(r, 'instagram', 'https://instagram.com/velvet.cosmetic.lounge'), r.filter(x=>x.channel==='instagram'));
  check('/_u placeholder rejected', !r.some((c) => c.value.endsWith('/_u')), r.filter(x=>x.channel==='instagram'));
  check('/_n deep link rejected', !r.some((c) => c.value.includes('/_n')), r.filter(x=>x.channel==='instagram'));
  check('underscore-only handle rejected', !r.some((c) => c.value.endsWith('/__')), r.filter(x=>x.channel==='instagram'));
}

console.log('# facebook SDK / tracking URLs (real leak from the run)');
{
  const r = detectContacts(`
    <a href="https://www.facebook.com/healthandbeautyzogopoulou/">FB page</a>
    <script src="https://connect.facebook.net/en_US/sdk.js"></script>
    <iframe src="https://www.facebook.com/v2.5/plugins/like.php?href=x"></iframe>
    <iframe src="https://www.facebook.com/v18.0/dialog/share?x=1"></iframe>
    <a href="https://facebook.com/health-beauty-%ce%99%ce%bd%cf%83">encoded share slug</a>`);
  check('real FB page kept', has(r, 'facebook', 'https://facebook.com/healthandbeautyzogopoulou'), r.filter(x=>x.channel==='facebook'));
  check('versioned /v2.5/plugins rejected', !r.some((c) => c.value.includes('plugins')), r.filter(x=>x.channel==='facebook'));
  check('versioned /v18.0/dialog rejected', !r.some((c) => c.value.includes('dialog')), r.filter(x=>x.channel==='facebook'));
  check('percent-encoded slug rejected', !r.some((c) => c.value.includes('%ce')), r.filter(x=>x.channel==='facebook'));
}

console.log('# emails: real vs junk');
{
  const r = detectContacts(`<a href="mailto:Info@Salon.gr">mail</a> <img src="logo@2x.png"> hello@example.com abc@sentry.wixpress.com`);
  check('mailto lowercased', has(r, 'email', 'info@salon.gr'), r);
  check('example.com rejected', !has(r, 'email', 'hello@example.com'), r);
  check('sentry/wix noise rejected', !r.some((c) => c.value.includes('sentry')), r);
}
console.log('# tel + contact form');
{
  const r = detectContacts(`<a href="tel:+302610223344">call</a><form><input type="email" name="email"><textarea name="message"></textarea></form>`);
  check('tel captured', has(r, 'phone', '+302610223344'), r);
  check('contact form captured', has(r, 'contact_form'), r);
}
console.log('# third-party pages: platform chrome must NOT become business contacts');
{
  // shape of a Treatwell listing / Facebook page: the platform's own socials in the footer
  const PLATFORM_PAGE = `
    <a href="https://www.instagram.com/treatwell">Treatwell on Instagram</a>
    <a href="https://www.facebook.com/treatwell">Treatwell on Facebook</a>
    <a href="https://www.facebook.com/recover/initiate">Forgotten password?</a>
    <a href="https://www.instagram.com/thesalonitself">the salon</a>
    <form><input type="email" name="email"><input name="pass"></form>
    <a href="https://wa.me/306912345678">WhatsApp us</a>
    support@treatwell.gr`;

  const onDirectory = detectContacts(PLATFORM_PAGE, { sourceType: 'directory', knownProfiles: ['https://www.treatwell.gr/place/eu-skin'] });
  check('platform instagram rejected', !onDirectory.some((c) => c.value.includes('treatwell')), onDirectory);
  check('platform facebook rejected', !onDirectory.some((c) => c.channel === 'facebook'), onDirectory);
  check('unrelated salon IG not attributed either', !onDirectory.some((c) => c.value.includes('thesalonitself')), onDirectory);
  check('platform login form NOT a contact form', !has(onDirectory, 'contact_form'), onDirectory);
  check('platform support email not collected', !onDirectory.some((c) => c.value.includes('treatwell.gr')), onDirectory);
  check('wa.me WITH a number is still trusted (explicit identifier)', has(onDirectory, 'whatsapp', '306912345678'), onDirectory);

  // the same markers on the business's OWN site are all legitimate
  const onOwnSite = detectContacts(PLATFORM_PAGE, { sourceType: 'owned_website' });
  check('own site: IG link kept', onOwnSite.some((c) => c.value.includes('thesalonitself')), onOwnSite);
  check('own site: contact form kept', has(onOwnSite, 'contact_form'), onOwnSite);

  // a social capture of the business's OWN profile still yields that profile
  const onOwnIg = detectContacts(`<a href="https://www.instagram.com/thesalonitself">me</a>`, {
    sourceType: 'instagram', knownProfiles: ['https://www.instagram.com/thesalonitself'] });
  check('own IG profile attributed on its own page', has(onOwnIg, 'instagram', 'https://instagram.com/thesalonitself'), onOwnIg);
}

console.log('# helpers');
check('normalizeMsisdn strips spaces', normalizeMsisdn('+30 691 234 5678') === '+306912345678');
check('normalizeMsisdn rejects short', normalizeMsisdn('1234') === null);
check('cleanProfileUrl drops query', cleanProfileUrl('https://www.instagram.com/beautify_patra?igsh=abc') === 'https://instagram.com/beautify_patra');
check('cleanProfileUrl drops the app share-link suffix', cleanProfileUrl('https://instagram.com/mc_laser_patras/profilecard/?igsh=NTc4MTIwNjQ2YQ==') === 'https://instagram.com/mc_laser_patras');
check('cleanProfileUrl drops instagram sub-pages', cleanProfileUrl('https://www.instagram.com/beautify_patra/reels/') === 'https://instagram.com/beautify_patra');
check('cleanProfileUrl drops facebook tabs', cleanProfileUrl('https://m.facebook.com/BeautifyPatra/about') === 'https://facebook.com/beautifypatra');
check('cleanProfileUrl keeps a deep-link placeholder path for the deny-list', cleanProfileUrl('https://instagram.com/_u/beautify_patra') === 'https://instagram.com/_u/beautify_patra');
{
  const { isTrustedSocialCapture } = await import('../src/enrichment/assetCollection.js');
  const verified = [{ channel: 'instagram', value: 'https://instagram.com/sic.beautyworks' }];
  check('photos come from a verified profile capture', isTrustedSocialCapture({ sourceType: 'instagram', url: 'https://www.instagram.com/sic.beautyworks/' }, verified));
  check('a rejected candidate profile is not mined', !isTrustedSocialCapture({ sourceType: 'instagram', url: 'https://www.instagram.com/kanina289' }, verified));
  check('a login wall is not mined', !isTrustedSocialCapture({ sourceType: 'instagram', url: 'https://www.instagram.com/accounts/login/?next=%2Fleoera' }, verified));
  check('the other platform needs its own verified contact', !isTrustedSocialCapture({ sourceType: 'facebook', url: 'https://facebook.com/sic.beautyworks' }, verified));
  check('the owned website is always mined', isTrustedSocialCapture({ sourceType: 'owned_website', url: 'https://sic.gr/' }, []));
}
check('cleanProfileUrl leaves non-social hosts alone', cleanProfileUrl('https://trendyhair.gr/services/nails/') === 'https://trendyhair.gr/services/nails');
check('classify instagram', classifySocialUrl('https://www.instagram.com/x') === 'instagram');
check('classify own domain -> null', classifySocialUrl('https://trendyhair.gr/') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
