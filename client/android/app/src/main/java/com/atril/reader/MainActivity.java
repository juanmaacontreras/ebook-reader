package com.atril.reader;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (see client/src/audio/nativeEngine.ts and
        // client/src/platform/updater.ts).
        registerPlugin(NarrationPlayerPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // Edge to edge: transparent system bars over the app's paper color.
        EdgeToEdge.enable(this);
    }
}
