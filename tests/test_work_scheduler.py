import threading
import time
import unittest

import download
from work_scheduler import WorkScheduler


class SchedulerTests(unittest.TestCase):
    def test_download_never_waits_for_existing_background_and_new_background_defers(self):
        scheduler = WorkScheduler(max_deferral=.1)
        with scheduler.background(threading.Event()), scheduler.foreground():
            pass
        entered = threading.Event()
        def background():
            with scheduler.background(threading.Event()): entered.set()
        with scheduler.foreground():
            thread = threading.Thread(target=background); thread.start()
            self.assertFalse(entered.wait(.03))
            self.assertTrue(entered.wait(.5))  # bounded starvation even during a long download
        thread.join()

    def test_cancel_interrupts_background_wait(self):
        scheduler = WorkScheduler(max_deferral=30)
        cancel = threading.Event()
        result = []
        def background():
            try:
                with scheduler.background(cancel): result.append('ran')
            except download.Cancelled: result.append('cancelled')
        with scheduler.foreground():
            thread = threading.Thread(target=background); thread.start()
            cancel.set(); thread.join(1)
        self.assertEqual(result, ['cancelled'])
