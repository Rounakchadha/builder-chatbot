<?php
/**
 * Plugin Name: Finfinity Loan Chatbot
 * Description: Embeds the Finfinity loan-eligibility chat widget site-wide. Set the backend API URL under Settings -> Finfinity Chatbot before the widget will appear.
 * Version: 1.0.0
 * Author: Finfinity
 * License: Proprietary
 *
 * How this works:
 * - widget.js (in assets/) is the exact same self-contained script the chatbot team builds and
 *   tests with — this plugin just loads it on every front-end page and points it at your backend.
 * - The widget itself renders a round chat button it manages entirely on its own (fixed position,
 *   bottom-right) — nothing else on the page needs to change.
 * - Nothing loads until the "Backend API URL" setting below is filled in, so installing this early
 *   (before the backend is deployed) is safe — it just stays inactive.
 *
 * To update the widget itself (a new chatbot release): replace assets/widget.js with the new build
 * and re-upload the plugin. The API URL setting is stored separately and survives that update.
 */

if (!defined('ABSPATH')) {
    exit; // no direct access
}

define('FINFINITY_CHATBOT_VERSION', '1.0.0');
define('FINFINITY_CHATBOT_OPTION', 'finfinity_chatbot_api_base');

/** Settings page: Settings -> Finfinity Chatbot, one field for the backend API base URL. */
function finfinity_chatbot_register_settings() {
    register_setting('finfinity_chatbot', FINFINITY_CHATBOT_OPTION, [
        'type' => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'default' => '',
    ]);

    add_settings_section(
        'finfinity_chatbot_section',
        'Finfinity Loan Chatbot',
        function () {
            echo '<p>The widget will not appear on the site until this is set to the chatbot backend\'s real, public, HTTPS URL (e.g. <code>https://chatbot-api.finfinity.co.in</code>) — no trailing slash.</p>';
        },
        'finfinity_chatbot'
    );

    add_settings_field(
        'finfinity_chatbot_api_base_field',
        'Backend API URL',
        function () {
            $value = get_option(FINFINITY_CHATBOT_OPTION, '');
            printf(
                '<input type="url" name="%s" value="%s" class="regular-text" placeholder="https://chatbot-api.finfinity.co.in" />',
                esc_attr(FINFINITY_CHATBOT_OPTION),
                esc_attr($value)
            );
        },
        'finfinity_chatbot',
        'finfinity_chatbot_section'
    );
}
add_action('admin_init', 'finfinity_chatbot_register_settings');

function finfinity_chatbot_add_settings_page() {
    add_options_page(
        'Finfinity Chatbot',
        'Finfinity Chatbot',
        'manage_options',
        'finfinity_chatbot',
        function () {
            ?>
            <div class="wrap">
                <h1>Finfinity Loan Chatbot</h1>
                <form action="options.php" method="post">
                    <?php
                    settings_fields('finfinity_chatbot');
                    do_settings_sections('finfinity_chatbot');
                    submit_button('Save');
                    ?>
                </form>
            </div>
            <?php
        }
    );
}
add_action('admin_menu', 'finfinity_chatbot_add_settings_page');

/** Loads widget.js site-wide on the front end, pointed at the configured backend — skipped
 * entirely (and silently) when no API URL has been set yet. */
function finfinity_chatbot_enqueue_widget() {
    if (is_admin()) {
        return;
    }

    $api_base = get_option(FINFINITY_CHATBOT_OPTION, '');
    if (empty($api_base)) {
        return; // not configured yet — nothing to load
    }

    // Security-review finding, 2026-10-23: a static version string meant a new widget.js drop
    // (re-uploading the plugin without a code change to this file) kept the exact same ?ver=
    // query string, so WordPress's own cache-busting never fired and some browsers/CDNs kept
    // serving the old cached file indefinitely. filemtime() ties the version to the actual file
    // on disk, so any widget.js replacement gets a fresh ?ver= automatically.
    $widget_path = plugin_dir_path(__FILE__) . 'assets/widget.js';
    $widget_version = file_exists($widget_path) ? (string) filemtime($widget_path) : FINFINITY_CHATBOT_VERSION;

    wp_enqueue_script(
        'finfinity-loan-chatbot',
        plugins_url('assets/widget.js', __FILE__),
        [],
        $widget_version,
        true // load in the footer
    );

    // The widget reads its backend URL from this attribute on its own <script> tag — stashed here
    // via a filter since wp_enqueue_script() has no built-in way to add a custom data-* attribute.
    add_filter('script_loader_tag', function ($tag, $handle) use ($api_base) {
        if ($handle !== 'finfinity-loan-chatbot') {
            return $tag;
        }
        return str_replace(
            ' src=',
            sprintf(' data-api-base="%s" defer src=', esc_attr($api_base)),
            $tag
        );
    }, 10, 2);
}
add_action('wp_enqueue_scripts', 'finfinity_chatbot_enqueue_widget');
