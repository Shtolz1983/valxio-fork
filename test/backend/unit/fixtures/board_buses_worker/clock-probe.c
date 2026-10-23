/*
 * clock-probe.c: a chip that reports the time it lives in, for the QEMU
 * worker rig (test_board_buses_f7_worker_clock.py).
 *
 * At setup it starts a 1 ms repeating timer; every fire logs the instant
 * vx_sim_now_nanos answers inside the callback. A watch on TRIG logs the
 * instant of every edge. Hosted by the worker, both instants have to be the
 * guest's clock (QEMU_CLOCK_VIRTUAL), not the worker's wall clock: a chip
 * that paces itself or measures the sketch's pulses reads the timeline the
 * sketch reads.
 */
#include "velxio-chip.h"
#include <stdio.h>

static vx_pin trig;
static vx_timer tmr;

static void say(const char* what) {
  char line[64];
  unsigned long long now = (unsigned long long)vx_sim_now_nanos();
  snprintf(line, sizeof(line), "%s now=%llu", what, now);
  vx_log(line);
}

static void on_tick(void* ud) { (void)ud; say("tick"); }

static void on_edge(void* ud, vx_pin pin, int value) {
  (void)ud; (void)pin; (void)value;
  say("edge");
}

void chip_setup(void) {
  trig = vx_pin_register("TRIG", VX_INPUT);
  vx_pin_watch(trig, VX_EDGE_BOTH, on_edge, 0);
  tmr = vx_timer_create(on_tick, 0);
  vx_timer_start(tmr, 1000000ull, true);
  vx_log("clock probe ready");
}
