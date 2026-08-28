import * as React from 'react'
import { PRODUCT_NAME } from '../../constants/product.js'
import { Box, Text } from '../../ink.js'

const WELCOME_MESSAGE = `Welcome to ${PRODUCT_NAME}`

/**
 * The header above the onboarding steps.
 *
 * Title and version only. This used to carry a block of ASCII art, written out
 * three times over — a light variant, a dark variant, and an Apple Terminal
 * variant that existed only because the art rendered badly there. All three
 * printed this same title line, so once the art went the theme branching and
 * the terminal special case had nothing left to decide between.
 */
export function WelcomeV2(): React.ReactNode {
  return (
    <Box>
      <Text>
        <Text color="startupAccent">{WELCOME_MESSAGE} </Text>
        <Text dimColor>v{MACRO.VERSION} </Text>
      </Text>
    </Box>
  )
}
