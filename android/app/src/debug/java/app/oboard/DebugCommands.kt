package app.oboard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug builds only. Lets automated tests drive the app from a computer:
 *   adb shell am broadcast -n app.oboard.debug/app.oboard.DebugCommands --es cmd selftest
 *   adb shell am broadcast -n app.oboard.debug/app.oboard.DebugCommands --es cmd conversation
 * Results are written to logcat under the tag VoiceSelfTest.
 */
class DebugCommands : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val cmd = intent.getStringExtra("cmd") ?: return
        (context.applicationContext as OBoardApp).container.debugCommands.tryEmit(cmd)
    }
}
