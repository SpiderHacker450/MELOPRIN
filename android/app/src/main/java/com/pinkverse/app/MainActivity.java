package com.pinkverse.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

/**
 * PINKVERSE Native Android Activity
 * Enforces native WindowManager.LayoutParams.FLAG_SECURE across the entire application lifecycle.
 * Protects against Android OS screenshots, screen recordings, non-secure display mirrors,
 * and recent-apps preview thumbnail capture.
 */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Apply FLAG_SECURE before any view inflation or sensitive photo rendering
        applyWindowProtection();
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Re-enforce protection upon returning from background, lock screen, or app switcher
        applyWindowProtection();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyWindowProtection();
        }
    }

    private void applyWindowProtection() {
        if (getWindow() != null) {
            getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE
            );
        }
    }
}
