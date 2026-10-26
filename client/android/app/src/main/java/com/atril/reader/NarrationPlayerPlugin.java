package com.atril.reader;

import android.content.ComponentName;
import android.content.Context;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * JS bridge to PlaybackService (see client/src/audio/nativeEngine.ts). Talks to
 * the service through a Media3 MediaController, which binds and starts it.
 * Controller calls must happen on the main thread; Capacitor calls arrive on a
 * background thread, so everything is posted to the main looper.
 */
@CapacitorPlugin(name = "NarrationPlayer")
public class NarrationPlayerPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private ListenableFuture<MediaController> future;
    private MediaController controller;

    private interface WithController { void run(MediaController c) throws Exception; }

    private void withController(PluginCall call, WithController fn) {
        main.post(() -> {
            if (future == null) {
                SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
                future = new MediaController.Builder(getContext(), token).buildAsync();
                future.addListener(() -> {
                    try {
                        controller = future.get();
                        controller.addListener(listener);
                    } catch (Exception e) {
                        future = null;
                    }
                }, MoreExecutors.directExecutor());
            }
            future.addListener(() -> main.post(() -> {
                if (controller == null) { call.reject("player unavailable"); return; }
                try {
                    fn.run(controller);
                } catch (Exception e) {
                    call.reject(e.getMessage());
                }
            }), MoreExecutors.directExecutor());
        });
    }

    private JSObject state(MediaController c) {
        JSObject o = new JSObject();
        o.put("index", c.getCurrentMediaItemIndex());
        o.put("time", c.getCurrentPosition() / 1000.0);
        o.put("playing", c.isPlaying() || (c.getPlayWhenReady() && c.getPlaybackState() == Player.STATE_BUFFERING));
        return o;
    }

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            if (controller != null) notifyListeners("state", state(controller));
        }

        @Override
        public void onMediaItemTransition(MediaItem item, int reason) {
            if (controller != null && reason != Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) {
                notifyListeners("track", state(controller));
            }
        }

        @Override
        public void onPositionDiscontinuity(@NonNull Player.PositionInfo oldPosition, @NonNull Player.PositionInfo newPosition, int reason) {
            if (controller != null && reason == Player.DISCONTINUITY_REASON_SEEK) notifyListeners("state", state(controller));
        }

        @Override
        public void onPlaybackStateChanged(int playbackState) {
            if (controller != null && playbackState == Player.STATE_ENDED) notifyListeners("ended", state(controller));
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            // Without this a broken file just plays nothing (see controller.ts onError).
            if (controller == null) return;
            JSObject o = state(controller);
            o.put("message", error.getErrorCodeName() + ": " + error.getMessage());
            notifyListeners("error", o);
        }
    };

    private MediaItem item(JSONObject t, String book, String author, String artwork, int id) {
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
                .setTitle(t.optString("title", book))
                .setArtist(author)
                .setAlbumTitle(book);
        if (artwork != null && !artwork.isEmpty()) meta.setArtworkUri(Uri.parse(artwork));
        return new MediaItem.Builder()
                .setMediaId(String.valueOf(id))
                .setUri(Uri.parse(t.optString("path")))
                .setMediaMetadata(meta.build())
                .build();
    }

    private String book = "", author = "", artwork = null;
    private int nextId = 0;

    @PluginMethod
    public void load(PluginCall call) {
        withController(call, c -> {
            JSArray tracks = call.getArray("tracks");
            book = call.getString("title", "");
            author = call.getString("author", "");
            artwork = call.getString("artwork");
            List<MediaItem> items = new ArrayList<>();
            for (int i = 0; i < tracks.length(); i++) items.add(item(tracks.getJSONObject(i), book, author, artwork, nextId++));
            int index = call.getInt("index", 0);
            long ms = (long) (call.getDouble("time", 0.0) * 1000);
            c.setMediaItems(items, index, ms);
            c.prepare();
            call.resolve();
        });
    }

    @PluginMethod
    public void append(PluginCall call) {
        withController(call, c -> {
            JSObject t = new JSObject();
            t.put("path", call.getString("path"));
            t.put("title", call.getString("title"));
            c.addMediaItem(item(t, book, author, artwork, nextId++));
            call.resolve();
        });
    }

    @PluginMethod
    public void play(PluginCall call) { withController(call, c -> { c.play(); call.resolve(); }); }

    @PluginMethod
    public void pause(PluginCall call) { withController(call, c -> { c.pause(); call.resolve(); }); }

    @PluginMethod
    public void seek(PluginCall call) {
        withController(call, c -> {
            c.seekTo(call.getInt("index", c.getCurrentMediaItemIndex()), (long) (call.getDouble("time", 0.0) * 1000));
            call.resolve();
        });
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        withController(call, c -> { c.setPlaybackSpeed(call.getFloat("rate", 1f)); call.resolve(); });
    }

    @PluginMethod
    public void getState(PluginCall call) { withController(call, c -> call.resolve(state(c))); }

    @PluginMethod
    public void getVolume(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        JSObject o = new JSObject();
        o.put("level", am.getStreamVolume(AudioManager.STREAM_MUSIC));
        o.put("max", am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        call.resolve(o);
    }

    @PluginMethod
    public void release(PluginCall call) {
        main.post(() -> {
            if (controller != null) {
                controller.stop();
                controller.clearMediaItems();
                controller.removeListener(listener);
                controller.release();
            }
            controller = null;
            future = null;
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> { if (controller != null) controller.release(); });
    }
}
