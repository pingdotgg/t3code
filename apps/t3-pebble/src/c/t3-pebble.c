#include <pebble.h>

#define MAX_THREADS 22
#define MAX_SECTIONS 24
#define SECTION_HEIGHT 22
#define ROW_HEIGHT 70
static Window *list_window, *detail_window;
static MenuLayer *menu;
#define MAX_CHAT 9
typedef struct {
  char type[24], text[961], summary[160], status[16], item[160];
} ChatItem;
static ChatItem chat[MAX_CHAT];
static int chat_count;
static Layer *chat_layer, *action_layer;
static int16_t touch_x, touch_y, touch_offset;
static bool touching;
static int16_t last_touch_y, touch_velocity;
static uint32_t last_touch_ms;
static char expanded_item[160];
static char titles[MAX_THREADS][100], ids[MAX_THREADS][161];
static char machines[MAX_THREADS][60], directories[MAX_THREADS][68], harnesses[MAX_THREADS][68], ages[MAX_THREADS][16];
#define PROVIDER_COUNT 7
static const char *provider_alias[] = { "codex", "claude", "cursor", "grok", "opencode", "antigravity", "kiro", "claudeAgent" };
static const int provider_alias_index[] = { 0, 1, 2, 3, 4, 5, 6, 1 };
static const uint32_t provider_logo_ids[PROVIDER_COUNT][2] = {
  { RESOURCE_ID_PROVIDER_CODEX_BLACK, RESOURCE_ID_PROVIDER_CODEX_WHITE },
  { RESOURCE_ID_PROVIDER_CLAUDE_BLACK, RESOURCE_ID_PROVIDER_CLAUDE_WHITE },
  { RESOURCE_ID_PROVIDER_CURSOR_BLACK, RESOURCE_ID_PROVIDER_CURSOR_WHITE },
  { RESOURCE_ID_PROVIDER_GROK_BLACK, RESOURCE_ID_PROVIDER_GROK_WHITE },
  { RESOURCE_ID_PROVIDER_OPENCODE_BLACK, RESOURCE_ID_PROVIDER_OPENCODE_WHITE },
  { RESOURCE_ID_PROVIDER_ANTIGRAVITY_BLACK, RESOURCE_ID_PROVIDER_ANTIGRAVITY_WHITE },
  { RESOURCE_ID_PROVIDER_KIRO_BLACK, RESOURCE_ID_PROVIDER_KIRO_WHITE },
};
static GBitmap *provider_logos[PROVIDER_COUNT][2];
static char section_titles[MAX_SECTIONS][40];
static int16_t section_start[MAX_SECTIONS], section_size[MAX_SECTIONS];
static int count, selected, section_count, thread_section;
static ScrollLayer *scroll;
static DictationSession *dictation;
static uint8_t *audio_data;
static uint32_t audio_size, audio_pos, audio_expected, audio_checksum;
static int16_t pcm[256];
static uint32_t pcm_size, pcm_pos;
static AppTimer *audio_timer, *momentum_timer;
static ScrollLayer *momentum_target;
static int momentum_velocity, momentum_remainder;
static bool playing;

static void send_request(const char *action, const char *thread, const char *message) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_cstring(out, MESSAGE_KEY_action, action);
  if (thread) dict_write_cstring(out, MESSAGE_KEY_thread, thread);
  if (message) dict_write_cstring(out, MESSAGE_KEY_message, message);
  app_message_outbox_send();
}
static void dictation_result(DictationSession *session, DictationSessionStatus status, char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess && count > 0)
    send_request("send", ids[selected], transcription);
}
static void select_detail(ClickRecognizerRef recognizer, void *context) {
  if (dictation && count > 0) dictation_session_start(dictation);
}
static void detail_clicks(void *context) { window_single_click_subscribe(BUTTON_ID_SELECT, select_detail); }
static GColor text_color(int style) {
  switch (style) {
    case 3: return GColorPastelYellow;
    case 4: return GColorPictonBlue;
    case 5: return GColorMintGreen;
    case 6: return GColorChromeYellow;
    case 7: return GColorLightGray;
    default: return GColorWhite;
  }
}
static int16_t formatted_text(GContext *ctx, const char *text, GRect area) {
  int16_t x = 0, y = 0;
  int style = 1;
  const int16_t line_height = 22;
  while (*text) {
    unsigned char c = (unsigned char)*text;
    if (c >= 1 && c <= 7) { style = c; text++; continue; }
    if (c == '\n') { x = 0; y += line_height; text++; continue; }
    GFont font = fonts_get_system_font(style == 2 ? FONT_KEY_GOTHIC_18_BOLD : FONT_KEY_GOTHIC_18);
    char word[128]; size_t n = 0;
    if (c == ' ' || c == '\t') { word[n++] = ' '; text++; }
    else {
      while (*text && (unsigned char)*text > 7 && *text != '\n' && *text != ' ' && *text != '\t' && n < sizeof(word) - 5) {
        unsigned char first = (unsigned char)*text;
        int bytes = first < 0x80 ? 1 : (first & 0xe0) == 0xc0 ? 2 : (first & 0xf0) == 0xe0 ? 3 : 4;
        for (int i = 0; i < bytes && *text && n < sizeof(word) - 1; i++) word[n++] = *text++;
      }
    }
    word[n] = 0;
    int16_t width = graphics_text_layout_get_content_size(word, font, GRect(0, 0, 1000, 100), GTextOverflowModeWordWrap, GTextAlignmentLeft).w;
    if (word[0] == ' ' && !word[1]) width = 4;
    if (width > area.size.w && n > 1) {
      text -= n;
      unsigned char first = (unsigned char)*text;
      n = first < 0x80 ? 1 : (first & 0xe0) == 0xc0 ? 2 : (first & 0xf0) == 0xe0 ? 3 : 4;
      for (size_t i = 0; i < n; i++) word[i] = *text++;
      word[n] = 0;
      width = graphics_text_layout_get_content_size(word, font, GRect(0, 0, 1000, 100), GTextOverflowModeWordWrap, GTextAlignmentLeft).w;
    }
    if (x && x + width > area.size.w) { x = 0; y += line_height; if (word[0] == ' ' && !word[1]) continue; }
    if (ctx) {
      graphics_context_set_text_color(ctx, text_color(style));
      graphics_draw_text(ctx, word, font, GRect(area.origin.x + x, area.origin.y + y, width + 2, line_height), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }
    x += width;
  }
  return y + line_height;
}
static bool chat_collapsible(int index) {
  return !strcmp(chat[index].type, "reasoning") || !strcmp(chat[index].type, "command_execution") || !strcmp(chat[index].type, "work_group");
}
static bool chat_collapsed(int index) {
  if (!chat_collapsible(index)) return false;
  const char *status = chat[index].status;
  if (!strcmp(status, "pending") || !strcmp(status, "running") || !strcmp(status, "waiting")) return false;
  return !chat[index].item[0] || strcmp(expanded_item, chat[index].item) != 0;
}
static const char *chat_body(int index) {
  if (!chat_collapsed(index)) return chat[index].text;
  if (chat[index].summary[0]) return chat[index].summary;
  return !strcmp(chat[index].type, "reasoning") ? "Thinking" : !strcmp(chat[index].type, "work_group") ? "Activity" : "Ran command";
}
static int16_t chat_height(int index, int16_t width) {
  return formatted_text(NULL, chat_body(index), GRect(0, 0, width - 32, 0)) + 27;
}
static void draw_chat(Layer *layer, GContext *ctx) {
  int16_t width = layer_get_bounds(layer).size.w, y = 4;
  GFont small = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  for (int i = 0; i < chat_count; i++) {
    bool user = !strcmp(chat[i].type, "user_message");
    bool assistant = !strcmp(chat[i].type, "assistant_message");
    int16_t height = chat_height(i, width);
    GRect bubble = GRect(user ? 12 : 3, y, width - 15, height);
    graphics_context_set_fill_color(ctx, user ? GColorOxfordBlue : GColorBlack);
    graphics_fill_rect(ctx, bubble, 7, GCornersAll);
    graphics_context_set_text_color(ctx, GColorWhite);
    const char *label = user ? "You" : assistant ? "Agent" : !strcmp(chat[i].type, "reasoning") ? "Thinking" : !strcmp(chat[i].type, "work_group") ? "Activity" : "Shell";
    if (!user && !assistant) {
      graphics_context_set_stroke_color(ctx, GColorWhite);
      if (!strcmp(chat[i].type, "reasoning")) {
        graphics_draw_circle(ctx, GPoint(bubble.origin.x + 10, y + 10), 5);
        graphics_draw_line(ctx, GPoint(bubble.origin.x + 8, y + 10), GPoint(bubble.origin.x + 12, y + 10));
      } else {
        graphics_draw_rect(ctx, GRect(bubble.origin.x + 5, y + 5, 11, 10));
        graphics_draw_line(ctx, GPoint(bubble.origin.x + 7, y + 8), GPoint(bubble.origin.x + 10, y + 10));
      }
    }
    graphics_draw_text(ctx, label, small, GRect(bubble.origin.x + (user || assistant ? 6 : 20), y + 1, width - 30, 20), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    if (chat_collapsible(i)) {
      graphics_draw_text(ctx, chat_collapsed(i) ? ">" : "v", small, GRect(width - 22, y + 1, 12, 18), GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
    }
    formatted_text(ctx, chat_body(i), GRect(bubble.origin.x + 6, y + 19, width - 32, height - 20));
    y += height + 5;
  }
}
static int16_t clamped_offset(ScrollLayer *target, int offset) {
  int16_t height = layer_get_bounds(scroll_layer_get_layer(target)).size.h;
  int16_t minimum = scroll_layer_get_content_size(target).h > height ? height - scroll_layer_get_content_size(target).h : 0;
  if (offset < minimum) return minimum;
  if (offset > 0) return 0;
  return offset;
}
static bool detail_at_bottom(void) {
  if (!scroll) return true;
  int16_t height = layer_get_bounds(scroll_layer_get_layer(scroll)).size.h;
  int16_t content = scroll_layer_get_content_size(scroll).h;
  int16_t minimum = content > height ? height - content : 0;
  return scroll_layer_get_content_offset(scroll).y <= minimum + 1;
}
static void draw_action(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  GPoint center = GPoint(bounds.size.w / 2, bounds.size.h / 2);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_circle(ctx, center, 19);
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_circle(ctx, center, 17);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_context_set_stroke_color(ctx, GColorWhite);
  if (detail_at_bottom()) {
    graphics_fill_rect(ctx, GRect(center.x - 3, center.y - 10, 6, 12), 3, GCornersAll);
    graphics_draw_line(ctx, GPoint(center.x - 7, center.y - 4), GPoint(center.x - 7, center.y + 2));
    graphics_draw_line(ctx, GPoint(center.x + 7, center.y - 4), GPoint(center.x + 7, center.y + 2));
    graphics_draw_line(ctx, GPoint(center.x - 7, center.y + 2), GPoint(center.x, center.y + 7));
    graphics_draw_line(ctx, GPoint(center.x + 7, center.y + 2), GPoint(center.x, center.y + 7));
    graphics_draw_line(ctx, GPoint(center.x, center.y + 7), GPoint(center.x, center.y + 12));
    graphics_draw_line(ctx, GPoint(center.x - 4, center.y + 12), GPoint(center.x + 4, center.y + 12));
  } else {
    graphics_draw_line(ctx, GPoint(center.x, center.y - 10), GPoint(center.x, center.y + 7));
    graphics_draw_line(ctx, GPoint(center.x - 7, center.y), GPoint(center.x, center.y + 7));
    graphics_draw_line(ctx, GPoint(center.x + 7, center.y), GPoint(center.x, center.y + 7));
  }
}
static void detail_offset_changed(ScrollLayer *target, void *context) {
  if (action_layer) layer_mark_dirty(action_layer);
}
static void set_offset(ScrollLayer *target, int offset, bool animated) {
  scroll_layer_set_content_offset(target, GPoint(0, clamped_offset(target, offset)), animated);
}
static void stop_momentum(void) {
  if (momentum_timer) app_timer_cancel(momentum_timer);
  momentum_timer = NULL;
  momentum_target = NULL;
  momentum_velocity = momentum_remainder = 0;
}
static void momentum_tick(void *context) {
  momentum_timer = NULL;
  if (!momentum_target) return;
  momentum_remainder += momentum_velocity;
  int step = momentum_remainder / 50;
  momentum_remainder %= 50;
  int16_t current = scroll_layer_get_content_offset(momentum_target).y;
  int16_t next = clamped_offset(momentum_target, current + step);
  set_offset(momentum_target, next, false);
  if (next == current || abs(momentum_velocity) < 70) {
    stop_momentum();
    return;
  }
  momentum_velocity = momentum_velocity * 92 / 100;
  momentum_timer = app_timer_register(20, momentum_tick, NULL);
}
static void start_momentum(ScrollLayer *target, int velocity) {
  stop_momentum();
  if (abs(velocity) < 80) return;
  if (velocity > 1800) velocity = 1800;
  if (velocity < -1800) velocity = -1800;
  momentum_target = target;
  momentum_velocity = velocity;
  momentum_timer = app_timer_register(20, momentum_tick, NULL);
}
static void update_chat(void) {
  if (!scroll || !chat_layer) return;
  GRect bounds = layer_get_bounds(window_get_root_layer(detail_window));
  int16_t width = bounds.size.w, height = 4;
  bool at_bottom = scroll_layer_get_content_size(scroll).h + scroll_layer_get_content_offset(scroll).y <= bounds.size.h + 1;
  for (int i = 0; i < chat_count; i++) height += chat_height(i, width) + 5;
  int16_t screen_height = bounds.size.h;
  height += 48;
  if (height < screen_height) height = screen_height;
  layer_set_frame(chat_layer, GRect(0, 0, width, height));
  scroll_layer_set_content_size(scroll, GSize(width, height));
  set_offset(scroll, at_bottom ? screen_height - height : scroll_layer_get_content_offset(scroll).y, false);
  layer_mark_dirty(chat_layer);
}
static void detail_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  scroll = scroll_layer_create(bounds);
  scroll_layer_set_click_config_onto_window(scroll, window);
  scroll_layer_set_callbacks(scroll, (ScrollLayerCallbacks){ .click_config_provider = detail_clicks, .content_offset_changed_handler = detail_offset_changed });
  chat_layer = layer_create(bounds);
  layer_set_update_proc(chat_layer, draw_chat);
  scroll_layer_add_child(scroll, chat_layer);
  layer_add_child(root, scroll_layer_get_layer(scroll));
  action_layer = layer_create(GRect((bounds.size.w - 40) / 2, bounds.size.h - 44, 40, 40));
  layer_set_update_proc(action_layer, draw_action);
  layer_add_child(root, action_layer);
  update_chat();
}
static void detail_unload(Window *window) {
  send_request("close", NULL, NULL);
  stop_momentum();
  playing = false; speaker_stop();
  free(audio_data); audio_data = NULL;
  if (audio_timer) { app_timer_cancel(audio_timer); audio_timer = NULL; }
  layer_destroy(action_layer); action_layer = NULL;
  layer_destroy(chat_layer); chat_layer = NULL;
  scroll_layer_destroy(scroll); scroll = NULL;
}
static void choose(int index, void *context) {
  if (!ids[index][0]) return;
  if (!strcmp(ids[index], "__next")) { send_request("next", NULL, NULL); return; }
  if (!strcmp(ids[index], "__previous")) { send_request("previous", NULL, NULL); return; }
  stop_momentum();
  expanded_item[0] = 0;
  selected = index;
  chat_count = 1;
  snprintf(chat[0].type, sizeof(chat[0].type), "reasoning");
  snprintf(chat[0].text, sizeof(chat[0].text), "Loading...");
  snprintf(chat[0].status, sizeof(chat[0].status), "running");
  chat[0].item[0] = chat[0].summary[0] = 0;
  window_stack_push(detail_window, true);
  send_request("read", ids[index], NULL);
}
static int16_t decode_mulaw(uint8_t value) {
  value = ~value;
  int sample = (((value & 15) << 3) + 132) << ((value & 112) >> 4);
  return (value & 128) ? 132 - sample : sample - 132;
}
static void audio_finished(SpeakerFinishReason reason, void *context) {
  if (playing && reason == SpeakerFinishReasonDone) {
    playing = false;
    free(audio_data); audio_data = NULL;
    send_request("audio_done", NULL, NULL);
  }
}
static void drain_audio(void *context) {
  audio_timer = NULL;
  if (!playing || !audio_data) return;
  while (true) {
    if (pcm_pos == pcm_size) {
      if (audio_pos == audio_size) { speaker_stream_close(); return; }
      uint32_t count = audio_size - audio_pos;
      if (count > 256) count = 256;
      for (uint32_t i = 0; i < count; i++) pcm[i] = decode_mulaw(audio_data[audio_pos++]);
      pcm_size = count * sizeof(int16_t); pcm_pos = 0;
    }
    uint32_t written = speaker_stream_write((uint8_t *)pcm + pcm_pos, pcm_size - pcm_pos);
    pcm_pos += written;
    if (pcm_pos < pcm_size) { audio_timer = app_timer_register(20, drain_audio, NULL); return; }
  }
}
static void add_section(const char *title) {
  if (section_count >= MAX_SECTIONS) return;
  snprintf(section_titles[section_count], sizeof(section_titles[section_count]), "%s", title);
  section_start[section_count] = count;
  section_size[section_count] = 0;
  thread_section = section_count++;
}
static void receive(DictionaryIterator *in, void *context) {
  Tuple *action = dict_find(in, MESSAGE_KEY_action);
  if (!action) return;
  if (!strcmp(action->value->cstring, "audio_start")) {
    Tuple *size = dict_find(in, MESSAGE_KEY_size), *checksum = dict_find(in, MESSAGE_KEY_checksum);
    playing = false; speaker_stop();
    if (audio_timer) { app_timer_cancel(audio_timer); audio_timer = NULL; }
    free(audio_data); audio_data = NULL;
    audio_size = 0;
    if (size && checksum && size->value->uint32 > 0 && size->value->uint32 <= 60000) {
      audio_expected = size->value->uint32; audio_checksum = checksum->value->uint32;
      audio_data = malloc(audio_expected);
    }
    if (!audio_data) send_request("audio_abort", NULL, NULL);
  } else if (!strcmp(action->value->cstring, "audio")) {
    Tuple *chunk = dict_find(in, MESSAGE_KEY_bytes);
    if (audio_data && chunk && audio_size + chunk->length <= audio_expected) {
      memcpy(audio_data + audio_size, chunk->value->data, chunk->length);
      audio_size += chunk->length;
      send_request("audio_ack", NULL, NULL);
    } else send_request("audio_retry", NULL, NULL);
  } else if (!strcmp(action->value->cstring, "audio_play")) {
    uint32_t checksum = 2166136261u;
    for (uint32_t i = 0; i < audio_size; i++) checksum = (checksum ^ audio_data[i]) * 16777619u;
    if (!audio_data || audio_size != audio_expected || checksum != audio_checksum) {
      free(audio_data); audio_data = NULL;
      send_request("audio_retry", NULL, NULL);
    } else {
      audio_pos = 0; pcm_size = pcm_pos = 0;
      playing = speaker_stream_open(SpeakerPcmFormat_8kHz_16bit, 80);
      if (playing) drain_audio(NULL); else send_request("audio_abort", NULL, NULL);
    }
  } else if (!strcmp(action->value->cstring, "clear")) {
    count = 0; section_count = 0; thread_section = -1;
  } else if (!strcmp(action->value->cstring, "section")) {
    Tuple *title = dict_find(in, MESSAGE_KEY_title);
    add_section(title ? title->value->cstring : "");
  } else if (!strcmp(action->value->cstring, "thread")) {
    Tuple *id = dict_find(in, MESSAGE_KEY_thread), *title = dict_find(in, MESSAGE_KEY_title);
    if (id && title && count < MAX_THREADS) {
      if (thread_section < 0) add_section("Threads");
      snprintf(ids[count], sizeof(ids[count]), "%s", id->value->cstring);
      snprintf(titles[count], sizeof(titles[count]), "%s", title->value->cstring);
      Tuple *machine = dict_find(in, MESSAGE_KEY_machine), *directory = dict_find(in, MESSAGE_KEY_directory);
      Tuple *harness = dict_find(in, MESSAGE_KEY_harness), *age = dict_find(in, MESSAGE_KEY_age);
      snprintf(machines[count], sizeof(machines[count]), "%s", machine ? machine->value->cstring : "");
      snprintf(directories[count], sizeof(directories[count]), "%s", directory ? directory->value->cstring : "");
      snprintf(harnesses[count], sizeof(harnesses[count]), "%s", harness ? harness->value->cstring : "");
      snprintf(ages[count], sizeof(ages[count]), "%s", age ? age->value->cstring : "");
      section_size[thread_section]++;
      count++;
    }
  } else if (!strcmp(action->value->cstring, "list")) {
    if (menu) menu_layer_reload_data(menu);
  } else if (!strcmp(action->value->cstring, "chat_clear")) {
    Tuple *id = dict_find(in, MESSAGE_KEY_thread);
    if (id && count && !strcmp(ids[selected], id->value->cstring)) chat_count = 0;
  } else if (!strcmp(action->value->cstring, "chat_item")) {
    Tuple *id = dict_find(in, MESSAGE_KEY_thread), *type = dict_find(in, MESSAGE_KEY_title), *body = dict_find(in, MESSAGE_KEY_message);
    if (id && type && body && count && chat_count < MAX_CHAT && !strcmp(ids[selected], id->value->cstring)) {
      Tuple *summary = dict_find(in, MESSAGE_KEY_summary), *status = dict_find(in, MESSAGE_KEY_status), *item = dict_find(in, MESSAGE_KEY_item);
      snprintf(chat[chat_count].type, sizeof(chat[chat_count].type), "%s", type->value->cstring);
      snprintf(chat[chat_count].text, sizeof(chat[chat_count].text), "%s", body->value->cstring);
      snprintf(chat[chat_count].summary, sizeof(chat[chat_count].summary), "%s", summary ? summary->value->cstring : "");
      snprintf(chat[chat_count].status, sizeof(chat[chat_count].status), "%s", status ? status->value->cstring : "completed");
      snprintf(chat[chat_count].item, sizeof(chat[chat_count].item), "%s", item ? item->value->cstring : "");
      chat_count++;
    }
  } else if (!strcmp(action->value->cstring, "chat_show")) {
    update_chat();
  }

}
static uint16_t list_sections(MenuLayer *layer, void *context) { return section_count ? section_count : 1; }
static uint16_t list_rows(MenuLayer *layer, uint16_t section, void *context) { return section < section_count ? section_size[section] : 0; }
static int16_t list_height(MenuLayer *layer, MenuIndex *index, void *context) { return ROW_HEIGHT; }
static int16_t list_header_height(MenuLayer *layer, uint16_t section, void *context) { return SECTION_HEIGHT; }
static void list_draw(GContext *ctx, const Layer *layer, MenuIndex *index, void *context) {
  int row = section_start[index->section] + index->row;
  int width = layer_get_bounds(layer).size.w;
  GColor ink = menu_layer_is_index_selected(menu, index) ? GColorWhite : GColorBlack;
  graphics_context_set_stroke_color(ctx, ink);
  graphics_context_set_text_color(ctx, ink);
  GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont meta_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  graphics_draw_text(ctx, titles[row], title_font, GRect(5, 0, width - 10, 25), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (!machines[row][0] && !directories[row][0] && !harnesses[row][0]) return;
  graphics_draw_rect(ctx, GRect(6, 29, 11, 8));
  graphics_draw_line(ctx, GPoint(11, 37), GPoint(11, 39));
  graphics_draw_line(ctx, GPoint(8, 39), GPoint(14, 39));
  graphics_draw_text(ctx, machines[row], meta_font, GRect(21, 24, width / 2 - 23, 19), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  int x = width / 2;
  graphics_draw_rect(ctx, GRect(x, 30, 12, 8));
  graphics_draw_line(ctx, GPoint(x + 1, 28), GPoint(x + 6, 28));
  graphics_draw_text(ctx, directories[row], meta_font, GRect(x + 16, 24, width - x - 19, 19), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  int provider = -1;
  for (size_t i = 0; i < sizeof(provider_alias) / sizeof(provider_alias[0]); i++)
    if (!strcmp(harnesses[row], provider_alias[i])) { provider = provider_alias_index[i]; break; }
  bool highlighted = menu_layer_is_index_selected(menu, index);
  GBitmap *logo = provider < 0 ? NULL : provider_logos[provider][highlighted ? 1 : 0];
  if (logo) {
    graphics_context_set_compositing_mode(ctx, GCompOpSet);
    graphics_draw_bitmap_in_rect(ctx, logo, GRect(4, 47, 14, 14));
    graphics_context_set_compositing_mode(ctx, GCompOpAssign);
  } else {
    graphics_draw_circle(ctx, GPoint(11, 54), 6);
    char initial[2] = { harnesses[row][0] ? harnesses[row][0] : '?', 0 };
    graphics_draw_text(ctx, initial, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), GRect(7, 45, 12, 18), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
  graphics_draw_text(ctx, harnesses[row], meta_font, GRect(21, 44, width - 68, 19), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, ages[row], meta_font, GRect(width - 45, 44, 40, 19), GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
}
static void list_header(GContext *ctx, const Layer *layer, uint16_t section, void *context) {
  menu_cell_basic_header_draw(ctx, layer, !count ? "No threads" : section < section_count && section_titles[section][0] ? section_titles[section] : "Threads");
}
static void list_select(MenuLayer *layer, MenuIndex *index, void *context) { choose(section_start[index->section] + index->row, NULL); }
static uint32_t touch_time_ms(void) {
  time_t seconds; uint16_t millis;
  time_ms(&seconds, &millis);
  return (uint32_t)seconds * 1000u + millis;
}
static void detail_tap(int16_t x, int16_t y) {
  GRect frame = layer_get_frame(action_layer);
  if (x >= frame.origin.x - 4 && x <= frame.origin.x + frame.size.w + 4 && y >= frame.origin.y - 4 && y <= frame.origin.y + frame.size.h + 4) {
    if (detail_at_bottom()) {
      if (dictation && count > 0) dictation_session_start(dictation);
    } else {
      int16_t height = layer_get_bounds(scroll_layer_get_layer(scroll)).size.h;
      set_offset(scroll, height - scroll_layer_get_content_size(scroll).h, true);
    }
    return;
  }
  int16_t content_y = y - scroll_layer_get_content_offset(scroll).y;
  int16_t row_y = 4;
  int16_t width = layer_get_bounds(chat_layer).size.w;
  for (int i = 0; i < chat_count; i++) {
    int16_t height = chat_height(i, width);
    if (content_y >= row_y && content_y < row_y + height) {
      if (!chat_collapsible(i) || !chat[i].item[0]) return;
      if (!strcmp(expanded_item, chat[i].item)) expanded_item[0] = 0;
      else snprintf(expanded_item, sizeof(expanded_item), "%s", chat[i].item);
      update_chat();
      return;
    }
    row_y += height + 5;
  }
}
static void list_tap(ScrollLayer *target, int16_t y) {
  int content_y = y - scroll_layer_get_content_offset(target).y;
  for (int section = 0; section < section_count; section++) {
    if (content_y < SECTION_HEIGHT) return;
    content_y -= SECTION_HEIGHT;
    int rows_height = section_size[section] * ROW_HEIGHT;
    if (content_y < rows_height) { choose(section_start[section] + content_y / ROW_HEIGHT, NULL); return; }
    content_y -= rows_height;
  }
}
static void on_touch(const TouchEvent *event, void *context) {
  Window *top = window_stack_get_top_window();
  ScrollLayer *target = top == detail_window ? scroll : menu ? menu_layer_get_scroll_layer(menu) : NULL;
  if (!target) return;
  if (event->type == TouchEvent_Touchdown) {
    light_enable_interaction(); touching = true; touch_x = event->x; touch_y = event->y;
    stop_momentum();
    touch_offset = scroll_layer_get_content_offset(target).y;
    set_offset(target, touch_offset, false);
    last_touch_y = event->y; last_touch_ms = touch_time_ms(); touch_velocity = 0;
  } else if (touching && event->type == TouchEvent_PositionUpdate) {
    int dx = event->x - touch_x, dy = event->y - touch_y;
    if (abs(dy) > 8 && abs(dy) > abs(dx)) {
      uint32_t now = touch_time_ms(), elapsed = now - last_touch_ms;
      if (elapsed > 0 && elapsed < 150) {
        int velocity = (event->y - last_touch_y) * 1000 / elapsed;
        if (velocity > 1800) velocity = 1800;
        if (velocity < -1800) velocity = -1800;
        touch_velocity = (touch_velocity + velocity) / 2;
      } else touch_velocity = 0;
      last_touch_y = event->y; last_touch_ms = now;
      set_offset(target, touch_offset + dy, false);
    }
  } else if (touching && event->type == TouchEvent_Liftoff) {
    touching = false;
    int dx = event->x - touch_x, dy = event->y - touch_y;
    if (top == detail_window && dx > 45 && abs(dy) < 35) window_stack_pop(true);
    else if (abs(dy) > 8 && abs(dy) > abs(dx) && touch_time_ms() - last_touch_ms < 150 && abs(touch_velocity) > 80) {
      int velocity = abs(touch_velocity);
      start_momentum(target, dy < 0 ? -velocity : velocity);
    } else if (abs(dx) < 12 && abs(dy) < 12) {
      if (top == detail_window) detail_tap(event->x, event->y);
      else list_tap(target, event->y);
    }
  }
}
static void list_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  menu = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(menu, NULL, (MenuLayerCallbacks){ .get_num_sections = list_sections, .get_num_rows = list_rows, .get_cell_height = list_height, .get_header_height = list_header_height, .draw_row = list_draw, .draw_header = list_header, .select_click = list_select });
  menu_layer_set_click_config_onto_window(menu, window);
  layer_add_child(root, menu_layer_get_layer(menu));
  for (int i = 0; i < PROVIDER_COUNT; i++)
    for (int variant = 0; variant < 2; variant++)
      provider_logos[i][variant] = gbitmap_create_with_resource(provider_logo_ids[i][variant]);
  send_request("list", NULL, NULL);
}
static void list_unload(Window *window) {
  stop_momentum();
  for (int i = 0; i < PROVIDER_COUNT; i++)
    for (int variant = 0; variant < 2; variant++) {
      gbitmap_destroy(provider_logos[i][variant]);
      provider_logos[i][variant] = NULL;
    }
  if (menu) { menu_layer_destroy(menu); menu = NULL; }
}
int main(void) {
  list_window = window_create(); detail_window = window_create();
  window_set_touch_bridge_disabled(list_window, true);
  window_set_touch_bridge_disabled(detail_window, true);
  window_set_window_handlers(list_window, (WindowHandlers){ .load = list_load, .unload = list_unload });
  window_set_window_handlers(detail_window, (WindowHandlers){ .load = detail_load, .unload = detail_unload });
  dictation = dictation_session_create(512, dictation_result, NULL);
  speaker_set_finish_callback(audio_finished, NULL);
  touch_service_subscribe(on_touch, NULL);
  app_message_register_inbox_received(receive);
  app_message_open(2048, 1024);
  window_stack_push(list_window, true);
  app_event_loop();
  touch_service_unsubscribe();
  speaker_set_finish_callback(NULL, NULL);
  free(audio_data);
  if (dictation) dictation_session_destroy(dictation);
  window_destroy(detail_window); window_destroy(list_window);
}
