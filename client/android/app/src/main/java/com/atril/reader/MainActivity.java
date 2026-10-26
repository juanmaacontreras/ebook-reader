package com.atril.reader;

import android.media.AudioManager;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (see client/src/audio/nativeEngine.ts,
        // client/src/platform/updater.ts and client/src/platform/keepAwake.ts).
        registerPlugin(NarrationPlayerPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(ScreenPlugin.class);
        super.onCreate(savedInstanceState);
        // Edge to edge: transparent system bars over the app's paper color.
        EdgeToEdge.enable(this);
        // The volume keys always change the media volume here, not the ringer:
        // this is a reading/listening app, and a muted media volume means narration
        // that seems to play but can't be heard.
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
    }
}
