'use client';

/**
 * The way out of «бракує: послуги» when the evidence has none to offer: a
 * dentist with no website and no social profile (2026-09-26) left Roman with
 * a blocked build and nothing to press. He knows what the practice does — the
 * Google listing's «Послуги» tab, the sign on the door — so he types it, and
 * the fact is recorded as his, with the date, like any other source.
 */

import { ActionForm } from './ActionForm';
import { addServices } from '@/lib/actions';

export function AddServicesForm({ businessId }: { businessId: string }) {
  return (
    <ActionForm action={addServices} className="mt-4 space-y-2.5 max-w-[62ch]">
      <input type="hidden" name="businessId" value={businessId} />
      <label className="block">
        <span className="label">Додай послуги сам — по одній у рядку, хоча б три</span>
        <textarea
          name="services"
          rows={4}
          placeholder={'Καθαρισμός δοντιών\nΛεύκανση\nΕμφυτεύματα'}
        />
      </label>
      <p className="text-sm text-ink-mute">
        Запишуться як факти від тебе (з датою), і фабрика одразу перевірить готовність знову.
        Ціни необовʼязкові; без них на сайті буде лише назва.
      </p>
      <button type="submit" className="btn-primary btn-sm">Додати і перевірити знову</button>
    </ActionForm>
  );
}
