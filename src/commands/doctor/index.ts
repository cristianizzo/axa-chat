import type { Command } from '../../commands.js'
import { PRODUCT_NAME } from '../../constants/product.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const doctor: Command = {
  name: 'doctor',
  description: `Diagnose and verify your ${PRODUCT_NAME} installation and settings`,
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
  type: 'local-jsx',
  load: () => import('./doctor.js'),
}

export default doctor
