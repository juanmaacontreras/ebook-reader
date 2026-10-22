package com.atril.reader;

import android.app.PendingIntent;
import android.content.Intent;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import com.google.common.collect.ImmutableList;

/**
 * Narration playback that survives the screen turning off: ExoPlayer inside a
 * Media3 MediaSessionService. Media3 runs it as a foreground service while
 * playing and draws the media notification; the MediaSession also receives
 * headphone, Bluetooth and lock-screen buttons. Chapters are local Ogg Opus
 * files (downloaded once per device, never streamed).
 */
public class PlaybackService extends MediaSessionService {
    static final long SKIP_MS = 30_000;
    private MediaSession session;

    @Override
    public void onCreate() {
        super.onCreate();
        ExoPlayer player = new ExoPlayer.Builder(this)
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                        .build(), /* handleAudioFocus= */ true)
                .setHandleAudioBecomingNoisy(true)  // pause when headphones are unplugged
                .setWakeMode(C.WAKE_MODE_LOCAL)
                .setSeekBackIncrementMs(SKIP_MS)
                .setSeekForwardIncrementMs(SKIP_MS)
                .build();

        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent activity = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        // Notification buttons: -30 s, play/pause, +30 s.
        CommandButton back = new CommandButton.Builder(CommandButton.ICON_SKIP_BACK_30)
                .setPlayerCommand(Player.COMMAND_SEEK_BACK)
                .setDisplayName("-30 s")
                .setSlots(CommandButton.SLOT_BACK)
                .build();
        CommandButton forward = new CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30)
                .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
                .setDisplayName("+30 s")
                .setSlots(CommandButton.SLOT_FORWARD)
                .build();

        session = new MediaSession.Builder(this, player)
                .setSessionActivity(activity)
                .setMediaButtonPreferences(ImmutableList.of(back, forward))
                .build();
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        // Swiping the app away keeps the narration going only if it is playing.
        Player player = session == null ? null : session.getPlayer();
        if (player == null || !player.getPlayWhenReady() || player.getMediaItemCount() == 0) stopSelf();
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.getPlayer().release();
            session.release();
            session = null;
        }
        super.onDestroy();
    }
}
