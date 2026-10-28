/**
 * Binds the Host's native Switch to the row form.
 *
 * This is the only module in the bundle that names the primitives client module,
 * so the form logic stays importable (and drivable) without the Host's module
 * loader — see `row-form.tsx`.
 */
import { Switch } from '../adapter/dsh/browser.js'
import type { SettingsProps } from './forms.js'
import { RowForm } from './row-form.js'

export function RowSettings(props: SettingsProps & { pwsh7Installed?: boolean }) {
  return <RowForm {...props} Switch={Switch} />
}
