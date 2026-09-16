import { Component, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { ElectronStoreService } from '../services/electron-store.service';

@Component({
  standalone: false,
  selector: 'app-home',
  templateUrl: './home.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./home.component.scss']
})
export class HomeComponent {
  public settings: any = {};
  public appVersion: string = null;
  public user: { login: string; password: string } = {
    login: '',
    password: ''
  };
  constructor(private router: Router, private store: ElectronStoreService) {
    this.settings = this.store.get('commonConfig');
    //console.info(this.settings);
    this.appVersion = this.store.get('appVersion');

    if (undefined !== this.settings && null !== this.settings && undefined !== this.settings.interfaceAutoConnect && null !== this.settings.interfaceAutoConnect && 'yes' === this.settings.interfaceAutoConnect) {
      this.store.set('loggedin', true);
      this.router.navigate(['/console']);
    }
  }

  public doLogin() {
    if ((this.user.login === 'admin' && this.user.password === 'admin')) {

      this.store.set('loggedin', true);

      if (undefined === this.settings) {
        this.router.navigate(['/settings']);
      } else {
        this.router.navigate(['/console']);
      }

    } else {
      new Notification('Error', {
        body: 'Oops! Please enter valid login credentials.'
      });
      this.router.navigate(['']);
    }

  }

}
