#include "MeasurementCacheUnderTest.h"
#import <Foundation/Foundation.h>
#include <cstring>

static NSMutableArray<dispatch_block_t> *background;
static NSMutableArray<dispatch_block_t> *mainQueue;

static void enqueue(dispatch_queue_t queue, dispatch_block_t block)
{
  [(queue == dispatch_get_main_queue() ? mainQueue : background) addObject:[block copy]];
}

// Control queue progress deterministically while executing the installed coordinator itself.
#define dispatch_async enqueue
#include "ENRMAsyncRenderCoordinator.m"
#undef dispatch_async

static void check(BOOL condition, const char *message)
{
  if (!condition)
  {
    fprintf(stderr, "FAIL: %s\n", message);
    exit(1);
  }
}

static void drain(NSMutableArray<dispatch_block_t> *queue)
{
  while (queue.count)
  {
    dispatch_block_t block = queue.firstObject;
    [queue removeObjectAtIndex:0];
    block();
  }
}

static void testCoordinator(void)
{
  background = [NSMutableArray new];
  mainQueue = [NSMutableArray new];
  ENRMAsyncRenderCoordinator *coordinator = [[ENRMAsyncRenderCoordinator alloc] initWithQueueLabel:"test"];
  __block NSUInteger rendered = 0;
  __block NSUInteger applied = 0;
  __weak NSObject *obsolete;
  @autoreleasepool
  {
    NSObject *document = [NSObject new];
    obsolete = document;
    [coordinator
        scheduleRender:^BOOL {
          (void)[document description];
          return YES;
        }
                 apply:^{
                 }];
  }
  for (NSUInteger revision = 1; revision <= 3; revision++)
  {
    [coordinator
        scheduleRender:^BOOL {
          rendered++;
          return YES;
        }
        apply:^{
          applied = revision;
        }];
  }
  printf("coordinator pending workers: %lu; obsolete document retained: %s\n",
         (unsigned long)background.count, obsolete ? "yes" : "no");
  check(obsolete == nil, "superseded pending documents must be released before the worker runs");
  check(background.count == 1, "a burst must enqueue one worker, not one closure per revision");
  drain(background);
  drain(mainQueue);
  check(rendered == 1 && applied == 3, "only the latest pending revision may parse and apply");

  NSMutableArray<NSString *> *renders = [NSMutableArray new];
  NSMutableArray<NSString *> *applies = [NSMutableArray new];
  [coordinator
      scheduleRender:^BOOL {
        [renders addObject:@"in-flight"];
        [coordinator
            scheduleRender:^BOOL {
              [renders addObject:@"obsolete"];
              return YES;
            }
            apply:^{
              [applies addObject:@"obsolete"];
            }];
        [coordinator
            scheduleRender:^BOOL {
              [renders addObject:@"latest"];
              return YES;
            }
            apply:^{
              [applies addObject:@"latest"];
            }];
        return YES;
      }
      apply:^{
        [applies addObject:@"in-flight"];
      }];
  drain(background);
  drain(mainQueue);
  check([renders isEqual:@[ @"in-flight", @"latest" ]],
        "work arriving during a render must replace the pending revision");
  check([applies isEqual:@[ @"latest" ]], "a completed superseded render must never apply");

  [coordinator
      scheduleRender:^BOOL {
        rendered++;
        return YES;
      }
      apply:^{
        applied++;
      }];
  [coordinator invalidate];
  drain(background);
  drain(mainQueue);
  check(rendered == 1 && applied == 3, "recycling must discard pending parsing and application");

  printf("PASS coordinator: latest pending revision, capture release, in-flight replacement, invalidation\n");
}

static void testCache(void)
{
  using namespace facebook::react;
  auto &cache = MeasurementCache::shared();
  CachedSize size;
  // Four duplicated 1 MiB strings exceed 8 MiB once key structs are included.
  MeasurementCacheKey keys[4]{};
  for (int index = 0; index < 4; index++)
    keys[index].markdown = std::string(1024 * 1024, char('a' + index));
  for (int index = 0; index < 3; index++)
    cache.set(keys[index], {double(index), 20});
  check(cache.get(keys[0], size), "a hit must remain available before budget eviction");
  cache.set(keys[3], {3, 20});
  check(!cache.get(keys[1], size), "byte overflow must evict the least recently used key");
  for (int index : {0, 2, 3})
    check(cache.get(keys[index], size) && size.width == index,
          "byte eviction must retain the other measurements");

  // An oversized key must bypass storage without flushing useful entries.
  for (auto field : {&MeasurementCacheKey::markdown, &MeasurementCacheKey::lineBreakStrategyIOS,
                     &MeasurementCacheKey::writingDirection, &MeasurementCacheKey::ellipsizeMode,
                     &MeasurementCacheKey::linkRegexKey, &MeasurementCacheKey::inlineCodeLinkRegexKey})
  {
    MeasurementCacheKey huge{};
    huge.*field = std::string(4 * 1024 * 1024, 'z');
    cache.set(huge, {99, 99});
    check(!cache.get(huge, size), "8 MiB includes both copies of every string and key structs");
  }
  for (int index : {0, 2, 3})
    check(cache.get(keys[index], size), "oversized keys must preserve useful measurements");

  cache.set(keys[0], {123, 456});
  cache.removeMatchingMarkdown(keys[2].markdown);
  cache.set(keys[1], {1, 20});
  check(cache.get(keys[0], size) && size.width == 123 && size.height == 456,
        "updates and removals must release or reuse capacity without spurious eviction");
  check(cache.get(keys[3], size) && cache.get(keys[1], size), "removed capacity must be reusable");
  check(!cache.get(keys[2], size), "removed measurements must stay absent");
  for (const auto &key : keys)
    cache.removeMatchingMarkdown(key.markdown);

  MeasurementCacheKey boundary{};
  const size_t budget = 8 * 1024 * 1024;
  const size_t structs = sizeof(MeasurementCache::CacheEntry) + sizeof(MeasurementCacheKey);
  boundary.markdown = std::string((budget - structs) / 2, 'b');
  cache.set(boundary, {8, 8});
  check(cache.get(boundary, size), "a key at the 8 MiB budget must fit");
  auto oversized = boundary;
  oversized.markdown += "b";
  cache.set(oversized, {9, 9});
  check(!cache.get(oversized, size), "a key above the 8 MiB budget must bypass storage");
  check(cache.get(boundary, size), "a rejected boundary key must not evict the cached key");
  cache.removeMatchingMarkdown(boundary.markdown);

  MeasurementCacheKey key{};
  for (int entry = 0; entry < 512; entry++)
  {
    key.markdown = std::to_string(entry);
    cache.set(key, {double(entry), 1});
  }
  key.markdown = "0";
  check(cache.get(key, size), "the entry limit must still allow 512 small documents");
  key.markdown = "new";
  cache.set(key, {1000, 1});
  key.markdown = "1";
  check(!cache.get(key, size), "entry overflow must evict the least recently used document");
  key.markdown = "0";
  check(cache.get(key, size), "reading a cache hit must refresh its LRU position");
  printf("PASS cache: 8 MiB byte eviction, oversized keys, updates/removal, 512-entry LRU\n");
}

int main(int argc, const char *argv[])
{
  @autoreleasepool
  {
    if (argc == 1 || strcmp(argv[1], "cache") == 0)
      testCache();
    if (argc == 1 || strcmp(argv[1], "coordinator") == 0)
      testCoordinator();
  }
}
